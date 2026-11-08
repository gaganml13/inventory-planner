/**
 * b2b_service.js — Unified B2B Wholesale Trade Network Service
 *
 * Implements:
 * - Zero Data Leakage DTOs (sanitizes private costs, cash, margins, and customer data)
 * - Verified Wholesale Directory & Public Catalog
 * - Smart Restock Matching (Excess Stock <-> Shortage matchmaking)
 * - Direct PO-to-SO Synchronized Trade Workflows (No inventory traps)
 */

'use strict';

class B2bService {
  constructor(db) {
    this.db = db;
  }

  /**
   * Sanitizes availability into privacy-safe badge without exposing exact warehouse balance.
   */
  getAvailabilityBadge(onHand) {
    if (onHand > 50) return { status: 'IN_STOCK', label: 'In Stock (High Availability)', color: 'emerald' };
    if (onHand > 0) return { status: 'LOW_STOCK', label: 'Low Stock (<50 available)', color: 'amber' };
    return { status: 'OUT_OF_STOCK', label: 'Out of Stock', color: 'rose' };
  }

  /**
   * Lists verified public wholesale directories (excluding current tenant).
   */
  listDirectories(currentBusinessId) {
    const rows = this.db.prepare(`
      SELECT 
        bp.business_id,
        bp.public_name,
        bp.category,
        bp.city,
        bp.gst_or_reg_no,
        bp.is_verified,
        bp.min_order_cents,
        bp.delivery_days,
        bp.description,
        (SELECT COUNT(*) FROM products p WHERE p.business_id = bp.business_id AND p.is_b2b_listed = 1 AND p.is_archived = 0) AS listed_products_count
      FROM b2b_profiles bp
      WHERE bp.is_public = 1 AND bp.business_id != ?
      ORDER BY bp.is_verified DESC, bp.public_name ASC
    `).all(currentBusinessId);

    return rows.map((r) => ({
      business_id: r.business_id,
      public_name: r.public_name,
      category: r.category,
      city: r.city,
      is_verified: Boolean(r.is_verified),
      min_order_cents: r.min_order_cents,
      min_order_formatted: `$${((r.min_order_cents || 0) / 100).toFixed(2)}`,
      delivery_days: r.delivery_days,
      description: r.description,
      listed_products_count: r.listed_products_count || 0
    }));
  }

  /**
   * Zero Data Leakage Public Catalog: Lists items published for wholesale trading.
   * Strips all internal costs, vendor contacts, and exact on-hand balances.
   */
  listB2bCatalog({ currentBusinessId, sellerBusinessId = null, category = null, query = null }) {
    let sql = `
      SELECT 
        p.id AS product_id,
        p.business_id AS seller_business_id,
        bp.public_name AS seller_name,
        bp.city AS seller_city,
        bp.delivery_days AS seller_lead_days,
        p.sku,
        p.barcode,
        p.name,
        p.category,
        p.base_unit,
        p.pack_size,
        COALESCE(p.b2b_price_cents, p.sell_price_cents) AS b2b_price_cents,
        COALESCE(p.b2b_moq, 1) AS b2b_moq,
        COALESCE(sm.on_hand, 0) AS on_hand
      FROM products p
      JOIN b2b_profiles bp ON p.business_id = bp.business_id
      LEFT JOIN (
        SELECT product_id, SUM(change_qty) AS on_hand
        FROM stock_movements
        GROUP BY product_id
      ) sm ON p.id = sm.product_id
      WHERE p.is_b2b_listed = 1 AND p.is_archived = 0 AND p.business_id != ?
    `;

    const params = [currentBusinessId];

    if (sellerBusinessId) {
      sql += ' AND p.business_id = ?';
      params.push(sellerBusinessId);
    }
    if (category) {
      sql += ' AND p.category = ?';
      params.push(category);
    }
    if (query) {
      sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)';
      params.push(`%${query}%`, `%${query}%`, `%${query}%`);
    }

    sql += ' ORDER BY p.name ASC';

    const rows = this.db.prepare(sql).all(...params);

    return rows.map((r) => {
      const avail = this.getAvailabilityBadge(r.on_hand);
      return {
        product_id: r.product_id,
        seller_business_id: r.seller_business_id,
        seller_name: r.seller_name,
        seller_city: r.seller_city,
        seller_lead_days: r.seller_lead_days || 3,
        sku: r.sku,
        barcode: r.barcode,
        name: r.name,
        category: r.category,
        base_unit: r.base_unit,
        pack_size: r.pack_size,
        b2b_price_cents: r.b2b_price_cents,
        b2b_price_formatted: `$${(r.b2b_price_cents / 100).toFixed(2)}`,
        b2b_moq: r.b2b_moq,
        availability: avail
        // Notice: cost_price_cents, operating_cash_cents, and exact on_hand are completely omitted!
      };
    });
  }

  /**
   * Smart Restock Matches: Cross-references current tenant's shortage / reorder needs
   * with items listed by other verified B2B wholesalers.
   */
  getRestockMatches(currentBusinessId) {
    // 1. Find current tenant's items with available stock < min_safety_stock
    const myShortages = this.db.prepare(`
      SELECT 
        p.id, p.sku, p.barcode, p.name, p.min_safety_stock, p.lead_days, p.cost_price_cents,
        (COALESCE(sm.on_hand, 0) - COALESCE(res.reserved, 0)) AS available,
        COALESCE(inc.incoming, 0) AS incoming
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(change_qty) AS on_hand
        FROM stock_movements WHERE business_id = ? GROUP BY product_id
      ) sm ON p.id = sm.product_id
      LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity - COALESCE(ol.fulfilled_quantity, 0)) AS reserved
        FROM order_lines ol JOIN orders o ON ol.order_id = o.id
        WHERE o.business_id = ? AND o.type = 'SALE' AND o.status IN ('CONFIRMED', 'APPROVED')
        GROUP BY ol.product_id
      ) res ON p.id = res.product_id
      LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity - COALESCE(ol.received_quantity, 0)) AS incoming
        FROM order_lines ol JOIN orders o ON ol.order_id = o.id
        WHERE o.business_id = ? AND o.type = 'PURCHASE' AND o.status IN ('CONFIRMED', 'APPROVED')
        GROUP BY ol.product_id
      ) inc ON p.id = inc.product_id
      WHERE p.business_id = ? AND p.is_archived = 0
    `).all(currentBusinessId, currentBusinessId, currentBusinessId, currentBusinessId);

    const matches = [];

    for (const sh of myShortages) {
      const isDeficit = (sh.available + sh.incoming) < (sh.min_safety_stock || 10);
      if (!isDeficit) continue;

      // Find partner products matching SKU or Barcode
      const sellerItem = this.db.prepare(`
        SELECT 
          p.id AS seller_product_id,
          p.business_id AS seller_business_id,
          bp.public_name AS seller_name,
          bp.city AS seller_city,
          bp.delivery_days,
          p.sku,
          p.name,
          p.b2b_price_cents,
          p.b2b_moq,
          p.pack_size,
          COALESCE(sm.on_hand, 0) AS seller_on_hand
        FROM products p
        JOIN b2b_profiles bp ON p.business_id = bp.business_id
        LEFT JOIN (
          SELECT product_id, SUM(change_qty) AS on_hand
          FROM stock_movements GROUP BY product_id
        ) sm ON p.id = sm.product_id
        WHERE p.business_id != ? AND p.is_b2b_listed = 1 AND p.is_archived = 0
          AND (p.sku = ? OR (p.barcode IS NOT NULL AND p.barcode = ?))
        LIMIT 1
      `).get(currentBusinessId, sh.sku, sh.barcode);

      if (sellerItem && sellerItem.seller_on_hand > 0) {
        const standardCost = sh.cost_price_cents || 1000;
        const b2bCost = sellerItem.b2b_price_cents || standardCost;
        const savingsPct = standardCost > b2bCost ? Math.round(((standardCost - b2bCost) / standardCost) * 100) : 0;

        matches.push({
          my_product_id: sh.id,
          my_sku: sh.sku,
          my_name: sh.name,
          my_available: sh.available,
          my_min_safety_stock: sh.min_safety_stock,
          seller_business_id: sellerItem.seller_business_id,
          seller_product_id: sellerItem.seller_product_id,
          seller_name: sellerItem.seller_name,
          seller_city: sellerItem.seller_city,
          seller_lead_days: sellerItem.delivery_days || 3,
          b2b_price_cents: b2bCost,
          b2b_price_formatted: `$${(b2bCost / 100).toFixed(2)}`,
          b2b_moq: sellerItem.b2b_moq || 1,
          pack_size: sellerItem.pack_size || 1,
          availability: this.getAvailabilityBadge(sellerItem.seller_on_hand),
          savings_pct: savingsPct,
          headline: savingsPct > 0
            ? `Save ${savingsPct}% & Fast ${sellerItem.delivery_days}d Delivery: ${sellerItem.seller_name} has verified stock`
            : `Verified Fast Restock (${sellerItem.delivery_days}d Delivery): ${sellerItem.seller_name}`
        });
      }
    }

    return matches;
  }

  /**
   * One-Click PO-to-SO Direct Trade Request:
   * Buyer creates a request -> linked Draft PO in Buyer A, Inbound B2B Request in Seller B.
   * (Seller stock is NOT locked until Seller explicitly clicks [Accept Order]).
   */
  createTradeRequest({ buyerBusinessId, sellerBusinessId, items, tradeNotes = '' }) {
    if (buyerBusinessId === sellerBusinessId) {
      const err = new Error('A business cannot initiate a trade order with itself');
      err.code = 'SELF_TRADE_PROHIBITED';
      throw err;
    }

    const sellerBiz = this.db.prepare('SELECT * FROM businesses WHERE id = ?').get(sellerBusinessId);
    if (!sellerBiz) {
      const err = new Error('Seller wholesale business not found');
      err.code = 'SELLER_NOT_FOUND';
      throw err;
    }

    let tradeResult;

    const tx = this.db.transaction(() => {
      // 1. Ensure supplier contact exists in Buyer A's workspace
      let supplierContact = this.db.prepare(`
        SELECT id FROM contacts 
        WHERE business_id = ? AND (name = ? OR email LIKE ?)
        LIMIT 1
      `).get(buyerBusinessId, sellerBiz.name, `%${sellerBiz.slug}%`);

      if (!supplierContact) {
        const ins = this.db.prepare(`
          INSERT INTO contacts (business_id, type, name, email, payment_terms_days, credit_limit_cents)
          VALUES (?, 'SUPPLIER', ?, ?, 30, 5000000)
        `).run(buyerBusinessId, sellerBiz.name, `b2b-${sellerBiz.slug}@network.trade`);
        supplierContact = { id: ins.lastInsertRowid };
      }

      // 2. Build Buyer Draft PO
      let totalCents = 0;
      const orderLines = [];

      for (const it of items) {
        const sellerProd = this.db.prepare('SELECT * FROM products WHERE id = ? AND business_id = ?').get(it.seller_product_id, sellerBusinessId);
        if (!sellerProd) continue;

        const qty = parseInt(it.quantity, 10);
        if (isNaN(qty) || qty <= 0) continue;

        const unitCost = sellerProd.b2b_price_cents || sellerProd.sell_price_cents;
        const lineTotal = qty * unitCost;
        totalCents += lineTotal;

        // Find or map corresponding product in Buyer A's catalog
        let buyerProd = this.db.prepare('SELECT id FROM products WHERE business_id = ? AND sku = ?').get(buyerBusinessId, sellerProd.sku);
        if (!buyerProd) {
          const insProd = this.db.prepare(`
            INSERT INTO products (
              business_id, sku, barcode, name, category, base_unit, pack_size, lead_days,
              min_safety_stock, cost_price_cents, sell_price_cents
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 3, 10, ?, ?)
          `).run(
            buyerBusinessId, sellerProd.sku, sellerProd.barcode || sellerProd.sku,
            sellerProd.name, sellerProd.category, sellerProd.base_unit || 'units',
            sellerProd.pack_size || 1, unitCost, Math.round(unitCost * 1.35)
          );
          buyerProd = { id: insProd.lastInsertRowid };
        }

        orderLines.push({
          productId: buyerProd.id,
          sellerProductId: sellerProd.id,
          quantity: qty,
          unitCostCents: unitCost,
          lineTotalCents: lineTotal,
          packSize: sellerProd.pack_size || 1
        });
      }

      if (orderLines.length === 0) {
        const err = new Error('No valid items selected for B2B trade request');
        err.code = 'EMPTY_ITEMS';
        throw err;
      }

      const poOrderNum = `PO-B2B-${Date.now().toString().slice(-6)}`;
      const dueDate = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];

      const poRes = this.db.prepare(`
        INSERT INTO orders (
          business_id, contact_id, order_number, type, status, order_date, due_date,
          total_cents, paid_cents, notes, allow_backorder, source_tag
        ) VALUES (?, ?, ?, 'PURCHASE', 'DRAFT', date('now'), ?, ?, 0, ?, 1, 'B2B_NETWORK')
      `).run(buyerBusinessId, supplierContact.id, poOrderNum, dueDate, totalCents, `B2B Wholesale Request to ${sellerBiz.name}. ${tradeNotes}`);

      const buyerPoId = poRes.lastInsertRowid;

      for (const line of orderLines) {
        this.db.prepare(`
          INSERT INTO order_lines (
            order_id, product_id, quantity, pack_quantity, unit_price_cents, total_cents
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(buyerPoId, line.productId, line.quantity, Math.ceil(line.quantity / line.packSize), line.unitCostCents, line.lineTotalCents);
      }

      // 3. Create linked record in b2b_trade_orders
      const tradeRes = this.db.prepare(`
        INSERT INTO b2b_trade_orders (
          buyer_business_id, seller_business_id, buyer_po_id, status, total_cents, trade_notes
        ) VALUES (?, ?, ?, 'PENDING_APPROVAL', ?, ?)
      `).run(buyerBusinessId, sellerBusinessId, buyerPoId, totalCents, tradeNotes);

      tradeResult = {
        tradeOrderId: tradeRes.lastInsertRowid,
        buyerPoId,
        poNumber: poOrderNum,
        totalCents,
        status: 'PENDING_APPROVAL',
        sellerName: sellerBiz.name,
        message: 'B2B Trade Request sent. Seller stock is not locked until accepted.'
      };
    });

    tx();
    return tradeResult;
  }

  /**
   * Lists B2B orders (both inbound as seller, and outbound as buyer).
   */
  listTradeOrders(businessId) {
    const rows = this.db.prepare(`
      SELECT 
        t.*,
        buyer.name AS buyer_name,
        seller.name AS seller_name,
        po.order_number AS buyer_po_number,
        so.order_number AS seller_so_number
      FROM b2b_trade_orders t
      JOIN businesses buyer ON t.buyer_business_id = buyer.id
      JOIN businesses seller ON t.seller_business_id = seller.id
      LEFT JOIN orders po ON t.buyer_po_id = po.id
      LEFT JOIN orders so ON t.seller_so_id = so.id
      WHERE t.buyer_business_id = ? OR t.seller_business_id = ?
      ORDER BY t.created_at DESC
    `).all(businessId, businessId);

    return rows.map((r) => ({
      ...r,
      is_inbound: r.seller_business_id === businessId,
      total_formatted: `$${(r.total_cents / 100).toFixed(2)}`
    }));
  }

  /**
   * Seller Accepts Order:
   * - Creates/confirms a Sales Order in Seller B's workspace (reserving stock).
   * - Updates Buyer A's PO to CONFIRMED.
   */
  acceptTradeOrder(tradeOrderId, sellerBusinessId) {
    let result;

    const tx = this.db.transaction(() => {
      const trade = this.db.prepare('SELECT * FROM b2b_trade_orders WHERE id = ?').get(tradeOrderId);
      if (!trade) {
        const err = new Error('B2B Trade order not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (trade.seller_business_id !== sellerBusinessId) {
        const err = new Error('Only the designated seller can accept this B2B trade request');
        err.code = 'UNAUTHORIZED';
        throw err;
      }
      if (trade.status !== 'PENDING_APPROVAL') {
        const err = new Error(`Order cannot be accepted from state ${trade.status}`);
        err.code = 'INVALID_STATE';
        throw err;
      }

      const buyerBiz = this.db.prepare('SELECT * FROM businesses WHERE id = ?').get(trade.buyer_business_id);

      // 1. Ensure customer contact exists in Seller B's workspace
      let cust = this.db.prepare('SELECT id FROM contacts WHERE business_id = ? AND name = ? LIMIT 1').get(sellerBusinessId, buyerBiz.name);
      if (!cust) {
        const cIns = this.db.prepare(`
          INSERT INTO contacts (business_id, type, name, email, payment_terms_days, credit_limit_cents)
          VALUES (?, 'CUSTOMER', ?, ?, 30, 5000000)
        `).run(sellerBusinessId, buyerBiz.name, `buyer-${buyerBiz.slug}@network.trade`);
        cust = { id: cIns.lastInsertRowid };
      }

      // 2. Fetch lines from Buyer PO
      const buyerLines = this.db.prepare(`
        SELECT ol.*, p.sku 
        FROM order_lines ol 
        JOIN products p ON ol.product_id = p.id
        WHERE ol.order_id = ?
      `).all(trade.buyer_po_id);

      const soOrderNum = `SO-B2B-${Date.now().toString().slice(-6)}`;
      const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

      // 3. Create CONFIRMED Sales Order in Seller B's workspace
      const soRes = this.db.prepare(`
        INSERT INTO orders (
          business_id, contact_id, order_number, type, status, order_date, due_date,
          total_cents, paid_cents, notes, allow_backorder, source_tag
        ) VALUES (?, ?, ?, 'SALE', 'CONFIRMED', date('now'), ?, ?, 0, 'B2B Trade Fulfillment for Buyer', 1, 'B2B_NETWORK')
      `).run(sellerBusinessId, cust.id, soOrderNum, dueDate, trade.total_cents);

      const sellerSoId = soRes.lastInsertRowid;

      for (const bl of buyerLines) {
        const sellerProd = this.db.prepare('SELECT id, pack_size FROM products WHERE business_id = ? AND sku = ?').get(sellerBusinessId, bl.sku);
        if (sellerProd) {
          this.db.prepare(`
            INSERT INTO order_lines (order_id, product_id, quantity, pack_quantity, unit_price_cents, total_cents)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(sellerSoId, sellerProd.id, bl.quantity, Math.ceil(bl.quantity / (sellerProd.pack_size || 1)), bl.unit_price_cents, bl.total_cents);
        }
      }

      // 4. Update Buyer's PO to CONFIRMED
      this.db.prepare("UPDATE orders SET status = 'CONFIRMED', notes = notes || ' [Accepted by Seller]' WHERE id = ?").run(trade.buyer_po_id);

      // 5. Update B2B trade record
      this.db.prepare(`
        UPDATE b2b_trade_orders 
        SET status = 'ACCEPTED', seller_so_id = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        WHERE id = ?
      `).run(sellerSoId, tradeOrderId);

      result = {
        success: true,
        tradeOrderId,
        sellerSoId,
        soNumber: soOrderNum,
        status: 'ACCEPTED',
        message: 'Order accepted. Stock reserved in Seller inventory and Buyer PO confirmed.'
      };
    });

    tx();
    return result;
  }

  /**
   * Decline / Cancel B2B Order:
   * Releases any reserved stock without penalties.
   */
  declineOrCancelTrade(tradeOrderId, callerBusinessId, reason = 'Trade cancelled by participant') {
    let result;

    const tx = this.db.transaction(() => {
      const trade = this.db.prepare('SELECT * FROM b2b_trade_orders WHERE id = ?').get(tradeOrderId);
      if (!trade) {
        const err = new Error('B2B Trade order not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (trade.buyer_business_id !== callerBusinessId && trade.seller_business_id !== callerBusinessId) {
        const err = new Error('Not authorized to modify this B2B trade order');
        err.code = 'UNAUTHORIZED';
        throw err;
      }
      if (['SHIPPED', 'COMPLETED'].includes(trade.status)) {
        const err = new Error('Cannot cancel trade order that has already been shipped or completed');
        err.code = 'CANNOT_CANCEL_SHIPPED';
        throw err;
      }

      // Cancel Seller SO if created
      if (trade.seller_so_id) {
        this.db.prepare("UPDATE orders SET status = 'CANCELLED', notes = notes || ' [B2B Cancelled]' WHERE id = ?").run(trade.seller_so_id);
      }

      // Cancel Buyer PO if created
      if (trade.buyer_po_id) {
        this.db.prepare("UPDATE orders SET status = 'CANCELLED', notes = notes || ' [B2B Cancelled]' WHERE id = ?").run(trade.buyer_po_id);
      }

      const newStatus = trade.seller_business_id === callerBusinessId ? 'DECLINED' : 'CANCELLED';
      this.db.prepare(`
        UPDATE b2b_trade_orders 
        SET status = ?, trade_notes = trade_notes || ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        WHERE id = ?
      `).run(newStatus, ` [${newStatus}: ${reason}]`, tradeOrderId);

      result = {
        success: true,
        tradeOrderId,
        status: newStatus,
        message: `B2B Trade order ${newStatus.toLowerCase()}. Any stock reservations released.`
      };
    });

    tx();
    return result;
  }

  /**
   * Seller Marks Shipped:
   * Fulfills Seller's SO and updates Buyer PO to In-Transit.
   */
  markShipped(tradeOrderId, sellerBusinessId) {
    let result;

    const tx = this.db.transaction(() => {
      const trade = this.db.prepare('SELECT * FROM b2b_trade_orders WHERE id = ?').get(tradeOrderId);
      if (!trade || trade.seller_business_id !== sellerBusinessId) {
        const err = new Error('Trade order not found or unauthorized');
        err.code = 'NOT_FOUND';
        throw err;
      }

      if (trade.status !== 'ACCEPTED') {
        const err = new Error(`Only ACCEPTED orders can be marked shipped (current: ${trade.status})`);
        err.code = 'INVALID_STATE';
        throw err;
      }

      // Fulfill lines in Seller SO
      if (trade.seller_so_id) {
        const lines = this.db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(trade.seller_so_id);
        const loc = this.db.prepare('SELECT id FROM locations WHERE business_id = ? LIMIT 1').get(sellerBusinessId);
        const locId = loc ? loc.id : 1;

        for (const l of lines) {
          const onHandRow = this.db.prepare('SELECT COALESCE(SUM(change_qty), 0) AS on_hand FROM stock_movements WHERE product_id = ? AND business_id = ?').get(l.product_id, sellerBusinessId);
          const currentOnHand = onHandRow ? onHandRow.on_hand : 0;

          this.db.prepare(`
            INSERT INTO stock_movements (
              business_id, product_id, location_id, change_qty, balance_after, reason, order_line_id, source_tag
            ) VALUES (?, ?, ?, ?, ?, 'B2B_SHIPMENT_DISPATCH', ?, 'B2B_NETWORK')
          `).run(sellerBusinessId, l.product_id, locId, -l.quantity, currentOnHand - l.quantity, l.id);

          this.db.prepare('UPDATE order_lines SET fulfilled_quantity = quantity WHERE id = ?').run(l.id);
        }

        this.db.prepare("UPDATE orders SET status = 'FULFILLED' WHERE id = ?").run(trade.seller_so_id);
      }

      // Update Buyer PO
      if (trade.buyer_po_id) {
        this.db.prepare("UPDATE orders SET notes = notes || ' [In Transit — Ready to Receive]' WHERE id = ?").run(trade.buyer_po_id);
      }

      this.db.prepare("UPDATE b2b_trade_orders SET status = 'SHIPPED', updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = ?").run(tradeOrderId);

      result = { success: true, tradeOrderId, status: 'SHIPPED', message: 'Order marked shipped. Buyer notified.' };
    });

    tx();
    return result;
  }

  /**
   * Buyer Receives into Stock:
   * Adds physical stock into Buyer A's inventory and completes trade order.
   */
  receiveTradeIntoStock(tradeOrderId, buyerBusinessId) {
    let result;

    const tx = this.db.transaction(() => {
      const trade = this.db.prepare('SELECT * FROM b2b_trade_orders WHERE id = ?').get(tradeOrderId);
      if (!trade || trade.buyer_business_id !== buyerBusinessId) {
        const err = new Error('Trade order not found or unauthorized');
        err.code = 'NOT_FOUND';
        throw err;
      }

      if (trade.status !== 'SHIPPED' && trade.status !== 'ACCEPTED') {
        const err = new Error(`Order cannot be received from status ${trade.status}`);
        err.code = 'INVALID_STATE';
        throw err;
      }

      if (trade.buyer_po_id) {
        const lines = this.db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(trade.buyer_po_id);
        const loc = this.db.prepare('SELECT id FROM locations WHERE business_id = ? LIMIT 1').get(buyerBusinessId);
        const locId = loc ? loc.id : 1;

        for (const l of lines) {
          const onHandRow = this.db.prepare('SELECT COALESCE(SUM(change_qty), 0) AS on_hand FROM stock_movements WHERE product_id = ? AND business_id = ?').get(l.product_id, buyerBusinessId);
          const currentOnHand = onHandRow ? onHandRow.on_hand : 0;

          this.db.prepare(`
            INSERT INTO stock_movements (
              business_id, product_id, location_id, change_qty, balance_after, reason, order_line_id, source_tag
            ) VALUES (?, ?, ?, ?, ?, 'B2B_STOCK_RECEIPT', ?, 'B2B_NETWORK')
          `).run(buyerBusinessId, l.product_id, locId, l.quantity, currentOnHand + l.quantity, l.id);

          this.db.prepare('UPDATE order_lines SET received_quantity = quantity WHERE id = ?').run(l.id);
        }

        this.db.prepare("UPDATE orders SET status = 'FULFILLED', notes = notes || ' [Goods Received]' WHERE id = ?").run(trade.buyer_po_id);
      }

      this.db.prepare("UPDATE b2b_trade_orders SET status = 'COMPLETED', updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = ?").run(tradeOrderId);

      result = { success: true, tradeOrderId, status: 'COMPLETED', message: 'Goods received into inventory ledger.' };
    });

    tx();
    return result;
  }
}

module.exports = B2bService;
