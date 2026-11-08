/**
 * partial_payments.test.js
 *
 * Validates correct AR/AP status updates across split transactions
 * and asserts that over-allocation is rejected.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { DatabaseConnection } = require('../database/connection');
const { runMigrations } = require('../database/migrator');
const PaymentService = require('../src/modules/payments/payment_service');
const OrderService = require('../src/modules/orders/order_service');

const TEST_DB = path.join(__dirname, 'test_payments.db');

function setupTestDb() {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }
  const db = new DatabaseConnection(TEST_DB);
  runMigrations(db);

  db.exec(`
    INSERT INTO businesses (name, cash_reserve_cents, operating_cash_cents)
    VALUES ('Financial Test Wholesale', 2000000, 10000000);

    INSERT INTO contacts (business_id, type, name, payment_terms_days)
    VALUES (1, 'CUSTOMER', 'Acme Mart', 30),
           (1, 'SUPPLIER', 'Global Supplier Co', 15);

    INSERT INTO products (
      business_id, sku, barcode, name, category, base_unit, pack_size,
      lead_days, min_safety_stock, cost_price_cents, sell_price_cents
    ) VALUES (1, 'PAY-SKU-01', '777888999', 'Payment Test Item', 'General', 'pcs', 1, 7, 5, 4000, 10000);
  `);

  return db;
}

test('Partial Payments: Validates split payments, AR/AP calculations and over-allocation guard', async (t) => {
  const db = setupTestDb();
  const orderService = new OrderService(db);
  const paymentService = new PaymentService(db);

  // 1. Create a Customer SALE order for $1,000 (10 units * $100 = 100,000 cents)
  const saleOrder = orderService.createOrder({
    businessId: 1,
    contactId: 1,
    orderNumber: 'SO-PAY-01',
    type: 'SALE',
    dueDate: '2026-11-15',
    lines: [{ product_id: 1, quantity: 10, unit_price_cents: 10000 }]
  });

  assert.equal(saleOrder.total_cents, 100000, 'Order total should be $1,000 (100,000 cents)');
  assert.equal(saleOrder.paid_cents, 0, 'Order initially has 0 paid');

  // Verify Accounts Receivable reflects the full $1,000
  let fin = paymentService.getFinancialSummary(1);
  assert.equal(fin.accountsReceivable.totalCents, 100000, 'Total AR should be 100,000 cents');

  // 2. Apply first partial payment: $400 (40,000 cents)
  const partPay1 = paymentService.recordPayment({
    orderId: saleOrder.id,
    amountCents: 40000,
    paymentMethod: 'BANK_TRANSFER',
    notes: 'Partial invoice payment tranche 1'
  });

  assert.equal(partPay1.newPaidCents, 40000);
  assert.equal(partPay1.remainingBalanceCents, 60000);
  assert.equal(partPay1.isFullyPaid, false);

  // AR should now be $600 (60,000 cents)
  fin = paymentService.getFinancialSummary(1);
  assert.equal(fin.accountsReceivable.totalCents, 60000, 'AR should decrease to 60,000 cents after partial payment');

  // 3. Attempt over-allocation: Try to pay $700 when only $600 remains (should fail)
  assert.throws(
    () => {
      paymentService.recordPayment({
        orderId: saleOrder.id,
        amountCents: 70000,
        paymentMethod: 'CHECK'
      });
    },
    (err) => {
      assert.equal(err.code, 'OVER_ALLOCATION_ERROR');
      return true;
    },
    'Should reject payment exceeding remaining balance'
  );

  // 4. Apply second partial payment: exactly remaining $600 (60,000 cents)
  const partPay2 = paymentService.recordPayment({
    orderId: saleOrder.id,
    amountCents: 60000,
    paymentMethod: 'CREDIT_CARD',
    notes: 'Final settlement'
  });

  assert.equal(partPay2.newPaidCents, 100000);
  assert.equal(partPay2.remainingBalanceCents, 0);
  assert.equal(partPay2.isFullyPaid, true);

  // AR should now be 0
  fin = paymentService.getFinancialSummary(1);
  assert.equal(fin.accountsReceivable.totalCents, 0, 'AR should be 0 once fully paid');

  // 5. Create a Supplier PURCHASE order for $500 (50,000 cents)
  const purchOrder = orderService.createOrder({
    businessId: 1,
    contactId: 2,
    orderNumber: 'PO-PAY-01',
    type: 'PURCHASE',
    dueDate: '2026-10-30',
    lines: [{ product_id: 1, quantity: 10, unit_price_cents: 5000 }]
  });

  fin = paymentService.getFinancialSummary(1);
  assert.equal(fin.accountsPayable.totalCents, 50000, 'AP should reflect 50,000 cents');

  // Pay $200 deposit to supplier
  paymentService.recordPayment({
    orderId: purchOrder.id,
    amountCents: 20000,
    paymentMethod: 'BANK_TRANSFER',
    notes: 'Supplier deposit'
  });

  fin = paymentService.getFinancialSummary(1);
  assert.equal(fin.accountsPayable.totalCents, 30000, 'AP should reflect remaining 30,000 cents');

  db.close();
  try { fs.unlinkSync(TEST_DB); } catch (e) {}
});
