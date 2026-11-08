/**
 * purchase_budget.test.js
 *
 * Confirms purchase recommendations never exceed available working capital
 * after deducting mandatory cash reserves and pending debt obligations (AP).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { DatabaseConnection } = require('../database/connection');
const { runMigrations } = require('../database/migrator');
const ReorderEngine = require('../src/modules/intelligence/reorder_engine');

const TEST_DB = path.join(__dirname, 'test_budget.db');

function setupTestDb() {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }
  const db = new DatabaseConnection(TEST_DB);
  runMigrations(db);

  // Business with:
  // operating_cash_cents: $10,000 (1,000,000 cents)
  // cash_reserve_cents:   $6,000   (600,000 cents)
  // -> Base working capital: $4,000 (400,000 cents)
  db.exec(`
    INSERT INTO businesses (name, cash_reserve_cents, operating_cash_cents)
    VALUES ('Budget Limited Wholesale', 600000, 1000000);

    INSERT INTO contacts (business_id, type, name) VALUES (1, 'SUPPLIER', 'Key Vendor');

    -- Upcoming Accounts Payable bill of $1,500 (150,000 cents) due in 5 days
    -- -> Available working capital for replenishment: $4,000 - $1,500 = $2,500 (250,000 cents)
    INSERT INTO orders (
      business_id, contact_id, order_number, type, status, due_date, total_cents, paid_cents
    ) VALUES (1, 1, 'PO-DUE-01', 'PURCHASE', 'CONFIRMED', date('now', '+5 days'), 150000, 0);

    -- Product A: High Margin ($50 cost, $150 sell), pack size 5 -> Pack cost $250 (25,000 cents)
    INSERT INTO products (
      business_id, sku, barcode, name, category, base_unit, pack_size,
      lead_days, min_safety_stock, cost_price_cents, sell_price_cents
    ) VALUES (1, 'PROD-A', 'B001', 'High Margin Widget', 'A', 'pcs', 5, 7, 10, 5000, 15000);

    -- Product B: Lower Margin ($100 cost, $120 sell), pack size 5 -> Pack cost $500 (50,000 cents)
    INSERT INTO products (
      business_id, sku, barcode, name, category, base_unit, pack_size,
      lead_days, min_safety_stock, cost_price_cents, sell_price_cents
    ) VALUES (1, 'PROD-B', 'B002', 'Low Margin Widget', 'B', 'pcs', 5, 7, 10, 10000, 12000);
  `);

  return db;
}

test('Purchase Budget Intelligence: Enforces strict working capital ceiling after debt and reserves', () => {
  const db = setupTestDb();
  const engine = new ReorderEngine(db);

  // Compute recommendations
  const result = engine.computeRecommendations(1);

  assert.ok(result.budget, 'Budget breakdown must be present');
  assert.equal(result.budget.operatingCashCents, 1000000);
  assert.equal(result.budget.cashReserveCents, 600000);
  assert.equal(result.budget.pendingApLeadWindowCents, 150000);

  // Available working capital = $10,000 - $6,000 - $1,500 = $2,500 (250,000 cents)
  assert.equal(
    result.budget.availableWorkingCapitalCents,
    250000,
    'Available working capital must accurately reflect operating cash minus reserves minus pending AP'
  );

  // Assert allocated budget NEVER exceeds available working capital
  assert.ok(
    result.budget.allocatedBudgetCents <= result.budget.availableWorkingCapitalCents,
    `Allocated budget (${result.budget.allocatedBudgetCents}) must never exceed available working capital (${result.budget.availableWorkingCapitalCents})`
  );

  assert.ok(
    result.budget.remainingWorkingCapitalCents >= 0,
    'Remaining working capital must never be negative'
  );

  // Sum of costs for PENDING/APPROVED recommendations
  const approvedTotalCost = result.recommendations
    .filter((r) => r.status === 'PENDING')
    .reduce((sum, r) => sum + r.costCents, 0);

  assert.ok(
    approvedTotalCost <= result.budget.availableWorkingCapitalCents,
    `Approved purchase total cost ($${approvedTotalCost / 100}) must stay strictly within available capital ($${result.budget.availableWorkingCapitalCents / 100})`
  );

  db.close();
  try { fs.unlinkSync(TEST_DB); } catch (e) {}
});
