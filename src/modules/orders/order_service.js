/**
 * order_service.js — Commercial Orders Lifecycle & Immediate Transaction Operations
 *
 * Implements:
 * - Multi-line order creation (SALE / PURCHASE / RETURN) with pack multipliers.
 * - Order confirmation (moves DRAFT -> CONFIRMED, establishing reservations or incoming PO commitments).
 * - Order fulfillment:
 *     SALE: atomically deducts stock movements; rejects underflow if allow_backorder=false.
 *     PURCHASE: atomically increases stock movements.
 * - Order cancellation: releases reservations or incoming commitments.
 */

'use strict';

const { getDb } = require('../../../database/connection');

class OrderService {
  constructor(customDb) {
    this.db = customDb || getDb();
  }

  /**
   * Creates a multi-line commercial order.
   */
  createOrder({ businessId, contactId, orderNumber, type, dueDate, notes = '', allowBackorder = false, lines = [] }) {
    if (!contactId || !type || !dueDate || !lines || lines.length === 0) {
      const err = new Error('contactId, type, dueDate, and at least one line item are required');
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const orderType = String(type).toUpperCase();
    if (!['SALE', 'PURCHASE', 'RETURN'].includes(orderType)) {
      const err = new Error("Order type must be 'SALE', 'PURCHASE', or 'RETURN'");
      err.code = 'INVALID_ORDER_TYPE';
      throw err;
    }

    let createdOrderId;

    const createTx = this.db.transaction(() => {
      // 1. Verify contact
      const contact = this.db.prepare('SELECT id, type, name FROM contacts WHERE id = ? AND business_id = ?').get(contactId, businessId);
      if (!contact) {
        const err = new Error(`Contact #${contactId} not found`);
        err.code = 'CONTACT_NOT_FOUND';
        throw err;
      }

      // Generate order number if not provided
      const finalOrderNumber = orderNumber || `${orderType.substring(0, 2)}-${Date.now().toString().slice(-6)}`;

      // 2. Validate line items and compute totals
      let orderTotalCents = 0;
      const validatedLines = [];

      for (const line of lines) {
        const prod = this.db.prepare('SELECT id, sku, name, pack_size, cost_price_cents, sell_price_cents, source_tag FROM products WHERE id = ? AND business_id = ?').get(line.product_id, businessId);
        if (!prod) {
          const err = new Error(`Product #${line.product_id} not found`);
          err.code = 'PRODUCT_NOT_FOUND';
          throw err;
        }

        const qty = parseInt(line.quantity, 10);
        if (isNaN(qty) || qty <= 0) {
          const err = new Error(`Invalid line quantity for ${prod.sku}`);
          err.code = 'INVALID_LINE_QUANTITY';
          throw err;
        }

        const packSize = prod.pack_size || 1;
        const packQty = line.pack_quantity ? parseInt(line.pack_quantity, 10) : Math.ceil(qty / packSize);
        const unitPrice = line.unit_price_cents !== undefined
          ? parseInt(line.unit_price_cents, 10)
          : (orderType === 'PURCHASE' ? prod.cost_price_cents : prod.sell_price_cents);
        const tax = parseInt(line.tax_cents || 0, 10);
        const discount = parseInt(line.discount_cents || 0, 10);
        const lineTotal = Math.max(0, (qty * unitPrice) + tax - discount);

        orderTotalCents += lineTotal;
        validatedLines.push({
          productId: prod.id,
          quantity: qty,
          packQuantity: packQty,
          unitPriceCents: unitPrice,
          taxCents: tax,
          discountCents: discount,
          totalCents: lineTotal
        });
      }

      // 3. Insert order header
      const orderRes = this.db.prepare(`
        INSERT INTO orders (
          business_id, contact_id, order_number, type, status, due_date,
          total_cents, paid_cents, notes, allow_backorder
        ) VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, 0, ?, ?)
      `).run(
        businessId,
        contactId,
        finalOrderNumber,
        orderType,
        dueDate,
        orderTotalCents,
        notes,
        allowBackorder ? 1 : 0
      );

      createdOrderId = orderRes.lastInsertRowid;

      // 4. Insert order lines
      const insertLineStmt = this.db.prepare(`
        INSERT INTO order_lines (
          order_id, product_id, quantity, pack_quantity, unit_price_cents,
          tax_cents, discount_cents, total_cents
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const vl of validatedLines) {
        insertLineStmt.run(
          createdOrderId,
          vl.productId,
          vl.quantity,
          vl.packQuantity,
          vl.unitPriceCents,
          vl.taxCents,
          vl.discountCents,
          vl.totalCents
        );
      }
    });

    createTx();
    return this.getOrderById(createdOrderId);
  }

  /**
   * Confirms a DRAFT order into CONFIRMED status.
   * If SALE and backorders not allowed, asserts current Available >= order quantity.
   */
  confirmOrder(orderId, businessId) {
    let result;

    const confirmTx = this.db.transaction(() => {
      const order = this.db.prepare('SELECT * FROM orders WHERE id = ? AND business_id = ?').get(orderId, businessId);
      if (!order) {
        const err = new Error(`Order #${orderId} not found`);
        err.code = 'ORDER_NOT_FOUND';
        throw err;
      }

      if (order.status !== 'DRAFT') {
        const err = new Error(`Order cannot be confirmed from status ${order.status}`);
        err.code = 'INVALID_ORDER_STATE';
        throw err;
      }

      // If SALE, check stock reservation capacity unless backorders allowed
      if (order.type === 'SALE' && !order.allow_backorder) {
        const lines = this.db.prepare('SELECT product_id, quantity FROM order_lines WHERE order_id = ?').all(orderId);
        for (const line of lines) {
          const onHandRow = this.db.prepare(`
            SELECT COALESCE(SUM(change_qty), 0) AS on_hand
            FROM stock_movements WHERE product_id = ? AND business_id = ?
          `).get(line.product_id, businessId);

          const reservedRow = this.db.prepare(`
            SELECT COALESCE(SUM(ol.quantity), 0) AS reserved
            FROM order_lines ol
            JOIN orders o ON ol.order_id = o.id
            WHERE o.business_id = ? AND o.type = 'SALE' AND o.status = 'CONFIRMED' AND ol.product_id = ?
          `).get(businessId, line.product_id);

          const available = (onHandRow ? onHandRow.on_hand : 0) - (reservedRow ? reservedRow.reserved : 0);
          if (available < line.quantity) {
            const prod = this.db.prepare('SELECT sku FROM products WHERE id = ?').get(line.product_id);
            const err = new Error(`Insufficient available stock to confirm order for ${prod ? prod.sku : line.product_id}. Available: ${available}, Required: ${line.quantity}.`);
            err.code = 'INSUFFICIENT_STOCK';
            throw err;
          }
        }
      }

      this.db.prepare("UPDATE orders SET status = 'CONFIRMED' WHERE id = ?").run(orderId);
      result = this.getOrderById(orderId);
    });

    confirmTx();
    return result;
  }

  /**
   * Fulfills an order atomically (all remaining quantities):
   * - SALE: Writes negative stock movements (reason: 'SALE_FULFILLMENT').
   * - PURCHASE: Writes positive stock movements (reason: 'PURCHASE_RECEIPT').
   */
  fulfillOrder(orderId, businessId, locationId = null) {
    let result;

    const fulfillTx = this.db.transaction(() => {
      const order = this.db.prepare('SELECT * FROM orders WHERE id = ? AND business_id = ?').get(orderId, businessId);
      if (!order) {
        const err = new Error(`Order #${orderId} not found`);
        err.code = 'ORDER_NOT_FOUND';
        throw err;
      }

      if (order.status === 'FULFILLED') {
        const err = new Error('Order is already fulfilled');
        err.code = 'ALREADY_FULFILLED';
        throw err;
      }

      if (order.status === 'CANCELLED') {
        const err = new Error('Cannot fulfill a cancelled order');
        err.code = 'INVALID_ORDER_STATE';
        throw err;
      }

      // Default to first location if not specified
      let targetLocId = locationId;
      if (!targetLocId) {
        const firstLoc = this.db.prepare('SELECT id FROM locations WHERE business_id = ? LIMIT 1').get(businessId);
        targetLocId = firstLoc ? firstLoc.id : 1;
      }

      const lines = this.db.prepare(`
        SELECT ol.id, ol.product_id, ol.quantity, ol.fulfilled_quantity, ol.received_quantity, p.sku, p.source_tag
        FROM order_lines ol
        JOIN products p ON ol.product_id = p.id
        WHERE ol.order_id = ?
      `).all(orderId);

      const moveInsert = this.db.prepare(`
        INSERT INTO stock_movements (
          business_id, product_id, location_id, change_qty, balance_after,
          reason, order_line_id, source_tag, stock_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')
      `);

      for (const line of lines) {
        const balanceRow = this.db.prepare(`
          SELECT COALESCE(SUM(change_qty), 0) AS on_hand
          FROM stock_movements 
          WHERE product_id = ? AND business_id = ? AND (stock_type = 'AVAILABLE' OR stock_type IS NULL)
        `).get(line.product_id, businessId);

        const currentOnHand = balanceRow ? balanceRow.on_hand : 0;

        let changeQty = 0;
        let reason = '';

        if (order.type === 'SALE') {
          const remainingToFulfill = Math.max(0, line.quantity - (line.fulfilled_quantity || 0));
          if (remainingToFulfill <= 0) continue;

          changeQty = -remainingToFulfill;
          reason = 'SALE_FULFILLMENT';
          const newBal = currentOnHand + changeQty;
          if (newBal < 0 && !order.allow_backorder) {
            const err = new Error(`Cannot fulfill SALE order: insufficient physical on-hand stock for ${line.sku}. On-hand: ${currentOnHand}, needed: ${remainingToFulfill}.`);
            err.code = 'INSUFFICIENT_STOCK';
            throw err;
          }
          moveInsert.run(businessId, line.product_id, targetLocId, changeQty, newBal, reason, line.id, line.source_tag || 'SYNTHETIC');
          this.db.prepare('UPDATE order_lines SET fulfilled_quantity = quantity WHERE id = ?').run(line.id);
        } else if (order.type === 'PURCHASE') {
          const remainingToReceive = Math.max(0, line.quantity - (line.received_quantity || 0));
          if (remainingToReceive <= 0) continue;

          changeQty = remainingToReceive;
          reason = 'PURCHASE_RECEIPT';
          const newBal = currentOnHand + changeQty;
          moveInsert.run(businessId, line.product_id, targetLocId, changeQty, newBal, reason, line.id, line.source_tag || 'SYNTHETIC');
          this.db.prepare('UPDATE order_lines SET received_quantity = quantity WHERE id = ?').run(line.id);
        } else if (order.type === 'RETURN') {
          const remainingToReturn = Math.max(0, line.quantity - (line.received_quantity || 0));
          if (remainingToReturn <= 0) continue;

          changeQty = remainingToReturn;
          reason = 'CUSTOMER_RETURN';
          const newBal = currentOnHand + changeQty;
          moveInsert.run(businessId, line.product_id, targetLocId, changeQty, newBal, reason, line.id, line.source_tag || 'SYNTHETIC');
          this.db.prepare('UPDATE order_lines SET received_quantity = quantity WHERE id = ?').run(line.id);
        }
      }

      this.db.prepare("UPDATE orders SET status = 'FULFILLED' WHERE id = ?").run(orderId);
      result = this.getOrderById(orderId);
    });

    fulfillTx();
    return result;
  }

  /**
   * Partially receives specific line quantities for a PURCHASE order.
   */
  receivePurchaseOrder({ orderId, businessId, locationId = null, items = [], userId = null }) {
    let result;

    const receiveTx = this.db.transaction(() => {
      const order = this.db.prepare('SELECT * FROM orders WHERE id = ? AND business_id = ?').get(orderId, businessId);
      if (!order) {
        const err = new Error(`Order #${orderId} not found`);
        err.code = 'ORDER_NOT_FOUND';
        throw err;
      }

      if (order.type !== 'PURCHASE') {
        const err = new Error('Only PURCHASE orders can be received');
        err.code = 'INVALID_ORDER_TYPE';
        throw err;
      }

      if (['FULFILLED', 'CANCELLED'].includes(order.status)) {
        const err = new Error(`Cannot receive items for order in status ${order.status}`);
        err.code = 'INVALID_ORDER_STATE';
        throw err;
      }

      let targetLocId = locationId;
      if (!targetLocId) {
        const firstLoc = this.db.prepare('SELECT id FROM locations WHERE business_id = ? LIMIT 1').get(businessId);
        targetLocId = firstLoc ? firstLoc.id : 1;
      }

      const moveInsert = this.db.prepare(`
        INSERT INTO stock_movements (
          business_id, product_id, location_id, change_qty, balance_after,
          reason, order_line_id, source_tag, stock_type, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const line = this.db.prepare('SELECT * FROM order_lines WHERE id = ? AND order_id = ?').get(item.line_id, orderId);
        if (!line) continue;

        const qtyToReceive = parseInt(item.quantity, 10);
        if (isNaN(qtyToReceive) || qtyToReceive <= 0) continue;

        const remaining = line.quantity - (line.received_quantity || 0);
        if (qtyToReceive > remaining) {
          const err = new Error(`Received quantity (${qtyToReceive}) exceeds remaining unreceived quantity (${remaining}) for line #${line.id}`);
          err.code = 'OVER_RECEIVE_ERROR';
          throw err;
        }

        const stockType = item.stock_type === 'DAMAGED' ? 'DAMAGED' : 'AVAILABLE';

        const balanceRow = this.db.prepare(`
          SELECT COALESCE(SUM(change_qty), 0) AS on_hand
          FROM stock_movements 
          WHERE product_id = ? AND business_id = ? AND (stock_type = ? OR (? = 'AVAILABLE' AND stock_type IS NULL))
        `).get(line.product_id, businessId, stockType, stockType);

        const currentOnHand = balanceRow ? balanceRow.on_hand : 0;
        const newBal = currentOnHand + qtyToReceive;

        moveInsert.run(
          businessId,
          line.product_id,
          targetLocId,
          qtyToReceive,
          newBal,
          stockType === 'DAMAGED' ? 'PURCHASE_RECEIPT_DAMAGED' : 'PURCHASE_PARTIAL_RECEIPT',
          line.id,
          'MANUAL',
          stockType,
          userId || null
        );

        this.db.prepare('UPDATE order_lines SET received_quantity = received_quantity + ? WHERE id = ?').run(qtyToReceive, line.id);
      }

      // Check whether all lines are fully received
      const unreceivedCount = this.db.prepare(`
        SELECT COUNT(*) AS remaining_count
        FROM order_lines
        WHERE order_id = ? AND received_quantity < quantity
      `).get(orderId).remaining_count;

      const newStatus = unreceivedCount === 0 ? 'FULFILLED' : 'PARTIALLY_RECEIVED';
      this.db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(newStatus, orderId);

      result = this.getOrderById(orderId);
    });

    receiveTx();
    return result;
  }

  /**
   * Partially fulfills specific line quantities for a SALE order.
   */
  fulfillSalesOrder({ orderId, businessId, locationId = null, items = [], userId = null }) {
    let result;

    const fulfillTx = this.db.transaction(() => {
      const order = this.db.prepare('SELECT * FROM orders WHERE id = ? AND business_id = ?').get(orderId, businessId);
      if (!order) {
        const err = new Error(`Order #${orderId} not found`);
        err.code = 'ORDER_NOT_FOUND';
        throw err;
      }

      if (order.type !== 'SALE') {
        const err = new Error('Only SALE orders can be fulfilled');
        err.code = 'INVALID_ORDER_TYPE';
        throw err;
      }

      if (['FULFILLED', 'CANCELLED'].includes(order.status)) {
        const err = new Error(`Cannot fulfill items for order in status ${order.status}`);
        err.code = 'INVALID_ORDER_STATE';
        throw err;
      }

      let targetLocId = locationId;
      if (!targetLocId) {
        const firstLoc = this.db.prepare('SELECT id FROM locations WHERE business_id = ? LIMIT 1').get(businessId);
        targetLocId = firstLoc ? firstLoc.id : 1;
      }

      const moveInsert = this.db.prepare(`
        INSERT INTO stock_movements (
          business_id, product_id, location_id, change_qty, balance_after,
          reason, order_line_id, source_tag, stock_type, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?)
      `);

      for (const item of items) {
        const line = this.db.prepare('SELECT ol.*, p.sku FROM order_lines ol JOIN products p ON ol.product_id = p.id WHERE ol.id = ? AND ol.order_id = ?').get(item.line_id, orderId);
        if (!line) continue;

        const qtyToFulfill = parseInt(item.quantity, 10);
        if (isNaN(qtyToFulfill) || qtyToFulfill <= 0) continue;

        const remaining = line.quantity - (line.fulfilled_quantity || 0);
        if (qtyToFulfill > remaining) {
          const err = new Error(`Fulfillment quantity (${qtyToFulfill}) exceeds remaining unfulfilled quantity (${remaining}) for line #${line.id}`);
          err.code = 'OVER_FULFILL_ERROR';
          throw err;
        }

        const balanceRow = this.db.prepare(`
          SELECT COALESCE(SUM(change_qty), 0) AS on_hand
          FROM stock_movements 
          WHERE product_id = ? AND business_id = ? AND (stock_type = 'AVAILABLE' OR stock_type IS NULL)
        `).get(line.product_id, businessId);

        const currentOnHand = balanceRow ? balanceRow.on_hand : 0;
        const newBal = currentOnHand - qtyToFulfill;

        if (newBal < 0 && !order.allow_backorder) {
          const err = new Error(`Cannot fulfill SALE order: insufficient physical stock for ${line.sku}. On-hand: ${currentOnHand}, needed: ${qtyToFulfill}`);
          err.code = 'INSUFFICIENT_STOCK';
          throw err;
        }

        moveInsert.run(
          businessId,
          line.product_id,
          targetLocId,
          -qtyToFulfill,
          newBal,
          'SALE_PARTIAL_FULFILLMENT',
          line.id,
          'MANUAL',
          userId || null
        );

        this.db.prepare('UPDATE order_lines SET fulfilled_quantity = fulfilled_quantity + ? WHERE id = ?').run(qtyToFulfill, line.id);
      }

      // Check whether all lines are fully fulfilled
      const unfulfilledCount = this.db.prepare(`
        SELECT COUNT(*) AS remaining_count
        FROM order_lines
        WHERE order_id = ? AND fulfilled_quantity < quantity
      `).get(orderId).remaining_count;

      const newStatus = unfulfilledCount === 0 ? 'FULFILLED' : 'PARTIALLY_FULFILLED';
      this.db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(newStatus, orderId);

      result = this.getOrderById(orderId);
    });

    fulfillTx();
    return result;
  }

  /**
   * Cancels an order safely, releasing any reservations or incoming commitments.
   */
  cancelOrder(orderId, businessId) {
    const cancelTx = this.db.transaction(() => {
      const order = this.db.prepare('SELECT * FROM orders WHERE id = ? AND business_id = ?').get(orderId, businessId);
      if (!order) {
        const err = new Error(`Order #${orderId} not found`);
        err.code = 'ORDER_NOT_FOUND';
        throw err;
      }

      if (order.status === 'FULFILLED') {
        const err = new Error('Fulfilled orders cannot be cancelled directly; please issue a RETURN order');
        err.code = 'FULFILLED_ORDER_CANCEL';
        throw err;
      }

      if (['PARTIALLY_FULFILLED', 'PARTIALLY_RECEIVED'].includes(order.status)) {
        const err = new Error('Partially processed orders cannot be directly cancelled. Process a return or adjustment for executed lines.');
        err.code = 'PARTIALLY_PROCESSED_CANCEL';
        throw err;
      }

      this.db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE id = ?").run(orderId);
    });

    cancelTx();
    return this.getOrderById(orderId);
  }

  /**
   * Retrieves single order by ID with line items and contact details.
   */
  getOrderById(orderId, businessId = null) {
    let sql = `
      SELECT 
        o.*,
        c.name AS contact_name,
        c.email AS contact_email,
        c.type AS contact_type,
        c.payment_terms_days,
        (o.total_cents - o.paid_cents) AS balance_cents
      FROM orders o
      JOIN contacts c ON o.contact_id = c.id
      WHERE o.id = ?
    `;
    const params = [orderId];
    if (businessId) {
      sql += ' AND o.business_id = ?';
      params.push(businessId);
    }
    const order = this.db.prepare(sql).get(...params);

    if (!order) return null;

    const lines = this.db.prepare(`
      SELECT 
        ol.*,
        p.sku,
        p.name AS product_name,
        p.category,
        p.base_unit,
        p.pack_size
      FROM order_lines ol
      JOIN products p ON ol.product_id = p.id
      WHERE ol.order_id = ?
      ORDER BY ol.id ASC
    `).all(orderId);

    const payments = this.db.prepare(`
      SELECT * FROM payment_allocations WHERE order_id = ? ORDER BY id DESC
    `).all(orderId);

    return { ...order, lines, payments };
  }

  /**
   * Lists orders with filters (type, status, contact_id).
   */
  listOrders({ businessId, type = null, status = null, contactId = null, limit = 50 }) {
    let sql = `
      SELECT 
        o.id,
        o.order_number,
        o.type,
        o.status,
        o.order_date,
        o.due_date,
        o.total_cents,
        o.paid_cents,
        (o.total_cents - o.paid_cents) AS balance_cents,
        o.allow_backorder,
        o.notes,
        c.id AS contact_id,
        c.name AS contact_name,
        c.type AS contact_type,
        (SELECT COUNT(*) FROM order_lines WHERE order_id = o.id) AS line_count
      FROM orders o
      JOIN contacts c ON o.contact_id = c.id
      WHERE o.business_id = ?
    `;
    const params = [businessId];

    if (type) {
      sql += ' AND o.type = ?';
      params.push(type);
    }
    if (status) {
      sql += ' AND o.status = ?';
      params.push(status);
    }
    if (contactId) {
      sql += ' AND o.contact_id = ?';
      params.push(contactId);
    }

    sql += ' ORDER BY o.id DESC LIMIT ?';
    params.push(Math.min(parseInt(limit, 10) || 50, 500));

    return this.db.prepare(sql).all(...params);
  }
}

module.exports = OrderService;
