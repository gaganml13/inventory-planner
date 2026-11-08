/**
 * payment_service.js — Cash Flow, Invoicing, Partial Payments & Ledger Allocations
 *
 * Implements:
 * - Partial and split payment allocations on orders.
 * - Anti-over-allocation validation (`amount_cents + paid_cents <= total_cents`).
 * - Dynamic Accounts Receivable (AR) & Accounts Payable (AP) calculation.
 * - Working capital and cash reserve tracking.
 */

'use strict';

const { getDb } = require('../../../database/connection');

class PaymentService {
  constructor(customDb) {
    this.db = customDb || getDb();
  }

  /**
   * Records a payment against an order with over-allocation prevention.
   */
  recordPayment({ orderId, amountCents, paymentMethod = 'BANK_TRANSFER', notes = '', recordedAt = null }) {
    const amount = parseInt(amountCents, 10);
    if (isNaN(amount) || amount <= 0) {
      const err = new Error('amountCents must be a positive integer in cents');
      err.code = 'INVALID_AMOUNT';
      throw err;
    }

    let result;

    const payTx = this.db.transaction(() => {
      // 1. Fetch order under lock
      const order = this.db.prepare('SELECT id, business_id, order_number, type, status, total_cents, paid_cents FROM orders WHERE id = ?').get(orderId);
      if (!order) {
        const err = new Error(`Order #${orderId} not found`);
        err.code = 'ORDER_NOT_FOUND';
        throw err;
      }

      if (order.status === 'CANCELLED') {
        const err = new Error(`Cannot apply payment to cancelled order ${order.order_number}`);
        err.code = 'INVALID_ORDER_STATE';
        throw err;
      }

      const remainingBalance = order.total_cents - order.paid_cents;
      if (amount > remainingBalance) {
        const err = new Error(`Payment of $${(amount / 100).toFixed(2)} exceeds remaining unpaid balance of $${(remainingBalance / 100).toFixed(2)} for ${order.order_number}`);
        err.code = 'OVER_ALLOCATION_ERROR';
        throw err;
      }

      // 2. Insert payment allocation
      const payRes = this.db.prepare(`
        INSERT INTO payment_allocations (
          order_id, amount_cents, payment_method, notes, recorded_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        orderId,
        amount,
        paymentMethod || 'BANK_TRANSFER',
        notes || '',
        recordedAt || new Date().toISOString()
      );

      // 3. Update order paid_cents
      const newPaid = order.paid_cents + amount;
      this.db.prepare('UPDATE orders SET paid_cents = ? WHERE id = ?').run(newPaid, orderId);

      // 4. Update business operating cash balance dynamically
      if (order.type === 'SALE') {
        this.db.prepare('UPDATE businesses SET operating_cash_cents = operating_cash_cents + ? WHERE id = ?').run(amount, order.business_id);
      } else if (order.type === 'PURCHASE') {
        this.db.prepare('UPDATE businesses SET operating_cash_cents = operating_cash_cents - ? WHERE id = ?').run(amount, order.business_id);
      }

      result = {
        paymentId: payRes.lastInsertRowid,
        orderId: order.id,
        orderNumber: order.order_number,
        allocatedAmountCents: amount,
        totalCents: order.total_cents,
        newPaidCents: newPaid,
        remainingBalanceCents: order.total_cents - newPaid,
        isFullyPaid: newPaid === order.total_cents
      };
    });

    payTx();
    return result;
  }

  /**
   * Voids an individual payment allocation, reversing operating cash and resetting order paid balance.
   */
  voidPaymentAllocation(paymentId, businessId, reason = 'Operator void') {
    let result;
    const voidTx = this.db.transaction(() => {
      const pay = this.db.prepare(`
        SELECT p.*, o.business_id, o.type AS order_type, o.order_number, o.paid_cents, o.total_cents
        FROM payment_allocations p
        JOIN orders o ON p.order_id = o.id
        WHERE p.id = ? AND o.business_id = ?
      `).get(paymentId, businessId);

      if (!pay) {
        const err = new Error(`Payment allocation #${paymentId} not found`);
        err.code = 'NOT_FOUND';
        throw err;
      }

      if (pay.is_voided) {
        const err = new Error('Payment allocation is already voided');
        err.code = 'ALREADY_VOIDED';
        throw err;
      }

      // Reverse cash effect
      if (pay.order_type === 'SALE') {
        this.db.prepare('UPDATE businesses SET operating_cash_cents = operating_cash_cents - ? WHERE id = ?').run(pay.amount_cents, businessId);
      } else if (pay.order_type === 'PURCHASE') {
        this.db.prepare('UPDATE businesses SET operating_cash_cents = operating_cash_cents + ? WHERE id = ?').run(pay.amount_cents, businessId);
      }

      // Update order paid_cents
      const newPaid = Math.max(0, pay.paid_cents - pay.amount_cents);
      this.db.prepare('UPDATE orders SET paid_cents = ? WHERE id = ?').run(newPaid, pay.order_id);

      // Mark allocation voided
      this.db.prepare(`
        UPDATE payment_allocations 
        SET is_voided = 1, void_reason = ?, voided_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        WHERE id = ?
      `).run(reason, paymentId);

      result = {
        success: true,
        paymentId,
        orderId: pay.order_id,
        orderNumber: pay.order_number,
        reversedAmountCents: pay.amount_cents,
        newPaidCents: newPaid,
        remainingBalanceCents: pay.total_cents - newPaid
      };
    });

    voidTx();
    return result;
  }

  /**
   * Dynamically calculates working capital, AR, AP, and overdue positions.
   */
  getFinancialSummary(businessId) {
    const biz = this.db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId) || {
      cash_reserve_cents: 5000000,
      operating_cash_cents: 15000000
    };

    // 1. Accounts Receivable (Customer Sales)
    const arRow = this.db.prepare(`
      SELECT 
        COALESCE(SUM(total_cents - paid_cents), 0) AS total_ar_cents,
        COALESCE(SUM(CASE WHEN due_date < date('now') THEN (total_cents - paid_cents) ELSE 0 END), 0) AS overdue_ar_cents,
        COUNT(CASE WHEN paid_cents < total_cents THEN 1 ELSE NULL END) AS open_invoices_count,
        COUNT(CASE WHEN due_date < date('now') AND paid_cents < total_cents THEN 1 ELSE NULL END) AS overdue_invoices_count
      FROM orders
      WHERE business_id = ? AND type = 'SALE' AND status != 'CANCELLED' AND paid_cents < total_cents
    `).get(businessId);

    // 2. Accounts Payable (Vendor Purchases - ap_14d strictly excludes unapproved DRAFT POs)
    const apRow = this.db.prepare(`
      SELECT 
        COALESCE(SUM(total_cents - paid_cents), 0) AS total_ap_cents,
        COALESCE(SUM(CASE WHEN due_date < date('now') THEN (total_cents - paid_cents) ELSE 0 END), 0) AS overdue_ap_cents,
        COALESCE(SUM(CASE WHEN due_date <= date('now', '+14 days') AND status != 'DRAFT' THEN (total_cents - paid_cents) ELSE 0 END), 0) AS ap_14d_cents,
        COALESCE(SUM(CASE WHEN due_date > date('now', '+14 days') THEN (total_cents - paid_cents) ELSE 0 END), 0) AS ap_beyond_14d_cents,
        COUNT(CASE WHEN paid_cents < total_cents THEN 1 ELSE NULL END) AS open_bills_count
      FROM orders
      WHERE business_id = ? AND type = 'PURCHASE' AND status != 'CANCELLED' AND paid_cents < total_cents
    `).get(businessId);

    // 3. Open DRAFT purchase orders (unconfirmed purchasing commitments)
    const draftPoRow = this.db.prepare(`
      SELECT COALESCE(SUM(total_cents), 0) AS draft_po_total_cents, COUNT(*) AS draft_po_count
      FROM orders
      WHERE business_id = ? AND type = 'PURCHASE' AND status = 'DRAFT'
    `).get(businessId);

    // 4. Inventory asset valuation
    const invRow = this.db.prepare(`
      SELECT COALESCE(SUM(sm.on_hand * p.cost_price_cents), 0) AS inventory_asset_value_cents
      FROM products p
      JOIN (
        SELECT product_id, SUM(change_qty) AS on_hand
        FROM stock_movements
        WHERE business_id = ? AND (stock_type = 'AVAILABLE' OR stock_type IS NULL)
        GROUP BY product_id
      ) sm ON p.id = sm.product_id
      WHERE p.business_id = ?
    `).get(businessId, businessId);

    const totalAr = arRow ? arRow.total_ar_cents : 0;
    const overdueAr = arRow ? arRow.overdue_ar_cents : 0;
    const totalAp = apRow ? apRow.total_ap_cents : 0;
    const overdueAp = apRow ? apRow.overdue_ap_cents : 0;
    const ap14dCents = apRow ? apRow.ap_14d_cents : 0;
    const apBeyond14dCents = apRow ? apRow.ap_beyond_14d_cents : 0;
    const draftPoCents = draftPoRow ? draftPoRow.draft_po_total_cents : 0;
    const inventoryValuation = invRow ? invRow.inventory_asset_value_cents : 0;

    const cashReserve = biz.cash_reserve_cents || 0;
    const operatingCash = biz.operating_cash_cents || 0;

    // Purchasing Budget: Cash specifically safe and available to deploy on procurement
    // Ensures mandatory cash reserve is never touched and upcoming 14d vendor debt is reserved
    const purchasingBudget = Math.max(0, operatingCash - cashReserve - ap14dCents);

    // Traditional Accounting Working Capital = Current Assets (Cash + AR + Inventory) - Current Liabilities (AP)
    const accountingWorkingCapital = (operatingCash + totalAr + inventoryValuation) - totalAp;

    return {
      businessId,
      currency: biz.currency || 'USD',
      cashReserveCents: cashReserve,
      operatingCashCents: operatingCash,
      purchasingBudgetCents: purchasingBudget,
      workingCapitalAvailableCents: purchasingBudget, // legacy alias
      freeWorkingCapitalCents: purchasingBudget,      // legacy alias
      accountingWorkingCapitalCents: accountingWorkingCapital,
      upcomingAp14dCents: ap14dCents,
      apBeyond14dCents: apBeyond14dCents,
      draftPoCommitmentsCents: draftPoCents,
      inventoryAssetValueCents: inventoryValuation,
      accountsReceivable: {
        totalCents: totalAr,
        overdueCents: overdueAr,
        openInvoicesCount: arRow ? arRow.open_invoices_count : 0,
        overdueInvoicesCount: arRow ? arRow.overdue_invoices_count : 0
      },
      accountsPayable: {
        totalCents: totalAp,
        overdueCents: overdueAp,
        upcoming14dCents: ap14dCents,
        openBillsCount: apRow ? apRow.open_bills_count : 0
      },
      netExpectedCashCents: operatingCash + totalAr - totalAp
    };
  }

  /**
   * Lists payments with optional order filter.
   */
  listPayments({ businessId, orderId = null, limit = 50 }) {
    let sql = `
      SELECT 
        pa.id,
        pa.order_id,
        pa.amount_cents,
        pa.payment_method,
        pa.notes,
        pa.recorded_at,
        o.order_number,
        o.type AS order_type,
        o.total_cents AS order_total_cents,
        o.paid_cents AS order_paid_cents,
        c.name AS contact_name
      FROM payment_allocations pa
      JOIN orders o ON pa.order_id = o.id
      JOIN contacts c ON o.contact_id = c.id
      WHERE o.business_id = ?
    `;
    const params = [businessId];

    if (orderId) {
      sql += ' AND pa.order_id = ?';
      params.push(orderId);
    }

    sql += ' ORDER BY pa.id DESC LIMIT ?';
    params.push(Math.min(parseInt(limit, 10) || 50, 500));

    return this.db.prepare(sql).all(...params);
  }
}

module.exports = PaymentService;
