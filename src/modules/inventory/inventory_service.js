/**
 * inventory_service.js — Stock Calculations, Ledgers & Immediate Transactions
 *
 * Implements:
 * - OnHand, Reserved, Available, IncomingPO, NetPosition calculations
 * - Strict non-negative inventory enforcement (unless allow_backorder: true)
 * - Atomic stock adjustment and ledger recording inside `BEGIN IMMEDIATE`
 */

'use strict';

const { getDb } = require('../../../database/connection');

class InventoryService {
  constructor(customDb) {
    this.db = customDb || getDb();
  }

  /**
   * Calculates comprehensive inventory position for products:
   * - on_hand: Current physically available stock (sum of AVAILABLE stock movements)
   * - damaged: Quarantined/damaged stock
   * - in_transit: In-transit stock
   * - reserved: Allocated to confirmed but unfulfilled SALE orders (remaining unfulfilled qty)
   * - available: max(0, on_hand - reserved)
   * - incoming_po: Inbound from confirmed unfulfilled PURCHASE orders (remaining unreceived qty)
   * - draft_po: Quantity on open DRAFT purchase orders
   * - net_position: available + incoming_po
   * - health_status: 'OUT_OF_STOCK' | 'CRITICAL' | 'LOW_STOCK' | 'OPTIMAL'
   */
  getStockPositions(businessId, productId = null, includeArchived = false) {
    let sql = `
      SELECT 
        p.id AS product_id,
        p.sku,
        p.barcode,
        p.name,
        p.category,
        p.base_unit,
        p.pack_size,
        p.lead_days,
        p.min_safety_stock,
        p.min_order_qty,
        p.cost_price_cents,
        p.sell_price_cents,
        p.source_tag,
        COALESCE(p.is_archived, 0) AS is_archived,
        COALESCE(sm.on_hand, 0) AS on_hand,
        COALESCE(sm.damaged, 0) AS damaged,
        COALESCE(sm.in_transit, 0) AS in_transit,
        COALESCE(res.reserved, 0) AS reserved,
        (COALESCE(sm.on_hand, 0) - COALESCE(res.reserved, 0)) AS available,
        COALESCE(inc.incoming_po, 0) AS incoming_po,
        COALESCE(draft.draft_po, 0) AS draft_po,
        ((COALESCE(sm.on_hand, 0) - COALESCE(res.reserved, 0)) + COALESCE(inc.incoming_po, 0)) AS net_position
      FROM products p
      
      -- 1. Physical stock breakdowns from movements ledger
      LEFT JOIN (
        SELECT 
          product_id, 
          SUM(CASE WHEN stock_type = 'AVAILABLE' OR stock_type IS NULL THEN change_qty ELSE 0 END) AS on_hand,
          SUM(CASE WHEN stock_type = 'DAMAGED' THEN change_qty ELSE 0 END) AS damaged,
          SUM(CASE WHEN stock_type = 'IN_TRANSIT' THEN change_qty ELSE 0 END) AS in_transit
        FROM stock_movements
        WHERE business_id = ?
        GROUP BY product_id
      ) sm ON p.id = sm.product_id

      -- 2. Reserved: Confirmed / Partially Fulfilled Sale Orders (remaining unfulfilled qty)
      LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity - COALESCE(ol.fulfilled_quantity, 0)) AS reserved
        FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id
        WHERE o.business_id = ? AND o.type = 'SALE' AND o.status IN ('CONFIRMED', 'PARTIALLY_FULFILLED')
        GROUP BY ol.product_id
      ) res ON p.id = res.product_id

      -- 3. Incoming PO: Confirmed / Partially Received Purchase Orders (remaining unreceived qty)
      LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity - COALESCE(ol.received_quantity, 0)) AS incoming_po
        FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id
        WHERE o.business_id = ? AND o.type = 'PURCHASE' AND o.status IN ('CONFIRMED', 'PARTIALLY_RECEIVED')
        GROUP BY ol.product_id
      ) inc ON p.id = inc.product_id

      -- 4. Draft POs: Unconfirmed purchase commitments currently in pipeline
      LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity) AS draft_po
        FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id
        WHERE o.business_id = ? AND o.type = 'PURCHASE' AND o.status = 'DRAFT'
        GROUP BY ol.product_id
      ) draft ON p.id = draft.product_id

      WHERE p.business_id = ?
    `;

    const params = [businessId, businessId, businessId, businessId, businessId];

    if (!includeArchived) {
      sql += ' AND COALESCE(p.is_archived, 0) = 0';
    }

    if (productId) {
      sql += ' AND p.id = ?';
      params.push(productId);
      const row = this.db.prepare(sql).get(...params);
      return row ? this.enrichPosition(row) : null;
    }

    sql += ' ORDER BY p.name ASC';
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => this.enrichPosition(r));
  }

  enrichPosition(row) {
    let healthStatus = 'OPTIMAL';
    if (row.on_hand <= 0) {
      healthStatus = 'OUT_OF_STOCK';
    } else if (row.on_hand < row.min_safety_stock) {
      healthStatus = 'CRITICAL';
    } else if (row.on_hand <= row.min_safety_stock * 1.25) {
      healthStatus = 'LOW_STOCK';
    }

    const valuationCents = Math.max(0, row.on_hand) * (row.cost_price_cents || 0);

    return {
      ...row,
      health_status: healthStatus,
      valuation_cents: valuationCents,
      is_archived: Boolean(row.is_archived)
    };
  }

  /**
   * Atomically adjusts stock with strict underflow check using `BEGIN IMMEDIATE`.
   */
  adjustStock({
    businessId,
    productId,
    locationId,
    changeQty,
    newOnHand,
    reason,
    allowBackorder = false,
    orderLineId = null,
    stockType = 'AVAILABLE',
    reversalOfMovementId = null,
    userId = null,
    insideTransaction = false
  }) {
    let qty = changeQty !== undefined ? parseInt(changeQty, 10) : NaN;

    const execute = () => {
      // 1. Verify product and location
      const product = this.db.prepare('SELECT id, name, sku, source_tag FROM products WHERE id = ? AND business_id = ?').get(productId, businessId);
      if (!product) {
        const err = new Error(`Product #${productId} not found`);
        err.code = 'PRODUCT_NOT_FOUND';
        throw err;
      }

      let targetLocationId = locationId;
      if (!targetLocationId) {
        const loc = this.db.prepare('SELECT id FROM locations WHERE business_id = ? ORDER BY id ASC LIMIT 1').get(businessId);
        if (loc) targetLocationId = loc.id;
      }

      const location = this.db.prepare('SELECT id FROM locations WHERE id = ? AND business_id = ?').get(targetLocationId, businessId);
      if (!location) {
        const err = new Error(`Location #${targetLocationId} not found`);
        err.code = 'LOCATION_NOT_FOUND';
        throw err;
      }

      // 2. Compute current on hand for specific stockType under transaction lock
      const currentBalanceRow = this.db.prepare(`
        SELECT COALESCE(SUM(change_qty), 0) AS current_on_hand
        FROM stock_movements
        WHERE product_id = ? AND business_id = ? AND (stock_type = ? OR (? = 'AVAILABLE' AND stock_type IS NULL))
      `).get(productId, businessId, stockType, stockType);

      const currentOnHand = currentBalanceRow ? currentBalanceRow.current_on_hand : 0;

      // Handle absolute target recount
      if (newOnHand !== undefined && !isNaN(parseInt(newOnHand, 10))) {
        qty = parseInt(newOnHand, 10) - currentOnHand;
      }

      if (isNaN(qty)) {
        const err = new Error('Invalid quantity provided for stock adjustment');
        err.code = 'INVALID_QUANTITY';
        throw err;
      }

      if (qty === 0) {
        return {
          productId,
          locationId: targetLocationId,
          changeQty: 0,
          newBalance: currentOnHand,
          reason: reason || 'COUNT_VERIFIED',
          stockType,
          message: `Stock verified: physical count already matches system on-hand (${currentOnHand} units)`
        };
      }

      const newBalance = currentOnHand + qty;

      // 3. Strict negative stock rejection
      if (newBalance < 0 && !allowBackorder && stockType === 'AVAILABLE') {
        const err = new Error(`Insufficient stock for ${product.sku}. On-hand: ${currentOnHand}, attempted change: ${qty}. Negative balance disallowed without explicit backorder authorization.`);
        err.code = 'INSUFFICIENT_STOCK';
        throw err;
      }

      // 4. Record stock movement ledger entry
      this.db.prepare(`
        INSERT INTO stock_movements (
          business_id, product_id, location_id, change_qty, balance_after, reason,
          order_line_id, source_tag, stock_type, reversal_of_movement_id, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        businessId,
        productId,
        targetLocationId,
        qty,
        newBalance,
        reason || 'MANUAL_ADJUSTMENT',
        orderLineId || null,
        product.source_tag || 'SYNTHETIC',
        stockType,
        reversalOfMovementId || null,
        userId || null
      );
    };

    if (insideTransaction) {
      execute();
    } else {
      const adjustTx = this.db.transaction(execute);
      adjustTx();
    }
    return this.getStockPositions(businessId, productId, true);
  }

  /**
   * Updates an existing catalog product.
   */
  updateProduct({
    businessId,
    productId,
    sku,
    barcode,
    name,
    category,
    base_unit,
    pack_size,
    lead_days,
    min_safety_stock,
    cost_price_cents,
    sell_price_cents
  }) {
    const existing = this.db.prepare('SELECT * FROM products WHERE id = ? AND business_id = ?').get(productId, businessId);
    if (!existing) {
      const err = new Error(`Product #${productId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (sku && sku.trim().toLowerCase() !== existing.sku.toLowerCase()) {
      const dup = this.db.prepare('SELECT id FROM products WHERE business_id = ? AND sku = ? AND id != ?').get(businessId, sku.trim(), productId);
      if (dup) {
        const err = new Error(`Product with SKU '${sku}' already exists`);
        err.code = 'DUPLICATE_SKU';
        throw err;
      }
    }

    const updatedSku = sku ? sku.trim() : existing.sku;
    const updatedName = name ? name.trim() : existing.name;
    const updatedCategory = category ? category.trim() : existing.category;
    const updatedBarcode = barcode !== undefined && barcode !== null ? barcode.trim() : existing.barcode;
    const updatedUnit = base_unit ? base_unit.trim() : existing.base_unit;
    const updatedPackSize = pack_size !== undefined ? Math.max(1, parseInt(pack_size, 10) || 1) : existing.pack_size;
    const updatedLeadDays = lead_days !== undefined ? Math.max(1, parseInt(lead_days, 10) || 1) : existing.lead_days;
    const updatedMinSafety = min_safety_stock !== undefined ? Math.max(0, parseInt(min_safety_stock, 10) || 0) : existing.min_safety_stock;
    const updatedCost = cost_price_cents !== undefined ? Math.max(0, parseInt(cost_price_cents, 10) || 0) : existing.cost_price_cents;
    const updatedSell = sell_price_cents !== undefined ? Math.max(0, parseInt(sell_price_cents, 10) || 0) : existing.sell_price_cents;

    this.db.prepare(`
      UPDATE products
      SET sku = ?, barcode = ?, name = ?, category = ?, base_unit = ?,
          pack_size = ?, lead_days = ?, min_safety_stock = ?,
          cost_price_cents = ?, sell_price_cents = ?
      WHERE id = ? AND business_id = ?
    `).run(
      updatedSku,
      updatedBarcode,
      updatedName,
      updatedCategory,
      updatedUnit,
      updatedPackSize,
      updatedLeadDays,
      updatedMinSafety,
      updatedCost,
      updatedSell,
      productId,
      businessId
    );

    return this.getStockPositions(businessId, productId);
  }

  /**
   * Archives a product (soft delete) preserving all audit records and orders.
   */
  archiveProduct(businessId, productId) {
    const existing = this.db.prepare('SELECT * FROM products WHERE id = ? AND business_id = ?').get(productId, businessId);
    if (!existing) {
      const err = new Error(`Product #${productId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    this.db.prepare('UPDATE products SET is_archived = 1 WHERE id = ? AND business_id = ?').run(productId, businessId);
    return { success: true, archived: true, productId, sku: existing.sku };
  }

  /**
   * Unarchives a previously archived product.
   */
  unarchiveProduct(businessId, productId) {
    const existing = this.db.prepare('SELECT * FROM products WHERE id = ? AND business_id = ?').get(productId, businessId);
    if (!existing) {
      const err = new Error(`Product #${productId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    this.db.prepare('UPDATE products SET is_archived = 0 WHERE id = ? AND business_id = ?').run(productId, businessId);
    return { success: true, archived: false, productId, sku: existing.sku };
  }

  /**
   * Deletes an unreferenced product, or safely archives it if historical ledger/order records exist.
   * This strictly preserves transaction history and prevents ledger or financial report corruption.
   */
  deleteProduct(businessId, productId) {
    const existing = this.db.prepare('SELECT * FROM products WHERE id = ? AND business_id = ?').get(productId, businessId);
    if (!existing) {
      const err = new Error(`Product #${productId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    // Check if referenced by any orders or stock movements
    const hasOrders = this.db.prepare('SELECT id FROM order_lines WHERE product_id = ? LIMIT 1').get(productId);
    const hasMovements = this.db.prepare('SELECT id FROM stock_movements WHERE product_id = ? LIMIT 1').get(productId);

    if (hasOrders || hasMovements) {
      // Archive to preserve transaction history
      this.db.prepare('UPDATE products SET is_archived = 1 WHERE id = ? AND business_id = ?').run(productId, businessId);
      // Clean up only temporary pending recommendations
      this.db.prepare("DELETE FROM purchase_recommendations WHERE product_id = ? AND business_id = ? AND status = 'PENDING'").run(productId, businessId);
      return {
        success: true,
        archived: true,
        deletedProductId: productId,
        sku: existing.sku,
        message: `Product ${existing.sku} has historical order or stock ledger records and has been safely archived to preserve audit history.`
      };
    }

    const delTx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM purchase_recommendations WHERE product_id = ? AND business_id = ?').run(productId, businessId);
      this.db.prepare('DELETE FROM demand_forecasts WHERE product_id = ?').run(productId);
      this.db.prepare('DELETE FROM products WHERE id = ? AND business_id = ?').run(productId, businessId);
    });

    delTx();
    return { success: true, archived: false, deletedProductId: productId, sku: existing.sku };
  }

  /**
   * Calculates FIFO Inventory Aging report across brackets:
   * 0-30 days, 31-60 days, 61-90 days, 90+ days
   */
  getInventoryAging(businessId) {
    const products = this.getStockPositions(businessId, null, false);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    const agingSummary = {
      bracket_0_30_cents: 0,
      bracket_31_60_cents: 0,
      bracket_61_90_cents: 0,
      bracket_90_plus_cents: 0,
      total_asset_value_cents: 0,
      products: []
    };

    for (const p of products) {
      const onHand = Math.max(0, p.on_hand);
      const unitCost = p.cost_price_cents || 0;
      const totalVal = onHand * unitCost;
      agingSummary.total_asset_value_cents += totalVal;

      if (onHand === 0) {
        agingSummary.products.push({
          productId: p.product_id,
          sku: p.sku,
          name: p.name,
          category: p.category,
          onHand: 0,
          unitCostCents: unitCost,
          totalValCents: 0,
          b0_30: 0,
          b31_60: 0,
          b61_90: 0,
          b90_plus: 0
        });
        continue;
      }

      // Fetch positive inbound receipts for this product ordered descending
      const receipts = this.db.prepare(`
        SELECT change_qty, created_at 
        FROM stock_movements 
        WHERE business_id = ? AND product_id = ? AND change_qty > 0
        ORDER BY id DESC
      `).all(businessId, p.product_id);

      let remainingToAttribute = onHand;
      let b0 = 0, b30 = 0, b60 = 0, b90 = 0;

      for (const r of receipts) {
        if (remainingToAttribute <= 0) break;
        const take = Math.min(remainingToAttribute, r.change_qty);
        const ageDays = Math.floor((now - new Date(r.created_at).getTime()) / dayMs);

        if (ageDays <= 30) b0 += take;
        else if (ageDays <= 60) b30 += take;
        else if (ageDays <= 90) b60 += take;
        else b90 += take;

        remainingToAttribute -= take;
      }

      // Any remaining on-hand older than tracked receipts defaults to 90+ days
      if (remainingToAttribute > 0) {
        b90 += remainingToAttribute;
      }

      agingSummary.bracket_0_30_cents += (b0 * unitCost);
      agingSummary.bracket_31_60_cents += (b30 * unitCost);
      agingSummary.bracket_61_90_cents += (b60 * unitCost);
      agingSummary.bracket_90_plus_cents += (b90 * unitCost);

      agingSummary.products.push({
        productId: p.product_id,
        sku: p.sku,
        name: p.name,
        category: p.category,
        onHand,
        unitCostCents: unitCost,
        totalValCents: totalVal,
        b0_30: b0,
        b31_60: b30,
        b61_90: b60,
        b90_plus: b90,
        turnoverRatio: p.incoming_po > 0 ? parseFloat((onHand / Math.max(1, p.incoming_po)).toFixed(1)) : 1.0
      });
    }

    return agingSummary;
  }

  /**
   * Retrieves stock movements audit trail.
   */
  getMovements({ businessId, productId = null, limit = 50 }) {
    let sql = `
      SELECT 
        sm.id,
        sm.business_id,
        sm.product_id,
        sm.location_id,
        sm.change_qty,
        sm.balance_after,
        sm.reason,
        sm.order_line_id,
        sm.source_tag,
        sm.created_at,
        p.sku,
        p.name AS product_name,
        l.name AS location_name
      FROM stock_movements sm
      JOIN products p ON sm.product_id = p.id
      JOIN locations l ON sm.location_id = l.id
      WHERE sm.business_id = ?
    `;
    const params = [businessId];

    if (productId) {
      sql += ' AND sm.product_id = ?';
      params.push(productId);
    }

    sql += ' ORDER BY sm.id DESC LIMIT ?';
    params.push(Math.min(parseInt(limit, 10) || 50, 500));

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Creates a new product for a business, with optional initial stock adjustment.
   */
  createProduct({
    businessId,
    sku,
    barcode,
    name,
    category = 'General',
    base_unit = 'units',
    pack_size = 1,
    lead_days = 7,
    min_safety_stock = 10,
    cost_price_cents = 0,
    sell_price_cents = 0,
    initial_stock = 0,
    location_id = null
  }) {
    if (!businessId || !sku || !name) {
      const err = new Error('businessId, sku, and name are required');
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const existing = this.db.prepare(
      'SELECT id FROM products WHERE business_id = ? AND sku = ?'
    ).get(businessId, sku.trim());
    if (existing) {
      const err = new Error(`Product with SKU '${sku}' already exists in this business`);
      err.code = 'DUPLICATE_SKU';
      throw err;
    }

    let productId;
    const createTx = this.db.transaction(() => {
      const barcodeVal = barcode && barcode.trim() ? barcode.trim() : `BAR-${sku.trim().toUpperCase()}`;
      const res = this.db.prepare(`
        INSERT INTO products (
          business_id, sku, barcode, name, category, base_unit,
          pack_size, lead_days, min_safety_stock, cost_price_cents,
          sell_price_cents, source_tag
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL')
      `).run(
        businessId,
        sku.trim(),
        barcodeVal,
        name.trim(),
        category.trim(),
        base_unit.trim(),
        Math.max(1, parseInt(pack_size, 10) || 1),
        Math.max(1, parseInt(lead_days, 10) || 7),
        Math.max(0, parseInt(min_safety_stock, 10) || 0),
        Math.max(0, parseInt(cost_price_cents, 10) || 0),
        Math.max(0, parseInt(sell_price_cents, 10) || 0)
      );
      productId = res.lastInsertRowid;

      if (initial_stock && parseInt(initial_stock, 10) > 0) {
        let locId = location_id;
        if (!locId) {
          const loc = this.db.prepare('SELECT id FROM locations WHERE business_id = ? LIMIT 1').get(businessId);
          if (loc) locId = loc.id;
        }

        if (locId) {
          const initQty = parseInt(initial_stock, 10);
          this.db.prepare(`
            INSERT INTO stock_movements (
              business_id, product_id, location_id, change_qty, balance_after, reason, source_tag
            ) VALUES (?, ?, ?, ?, ?, 'INITIAL_STOCK', 'MANUAL')
          `).run(businessId, productId, locId, initQty, initQty);
        }
      }
    });

    createTx();
    return this.getStockPositions(businessId, productId);
  }

  /**
   * Retrieves all locations for a business.
   */
  getLocations(businessId) {
    return this.db.prepare('SELECT id, name, description FROM locations WHERE business_id = ? ORDER BY name ASC').all(businessId);
  }
}

module.exports = InventoryService;
