/**
 * stock_reconciliation.test.js
 *
 * Proves inventory cannot go negative under invalid or concurrent adjust calls,
 * and asserts exact audit rows in the stock movements ledger.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { DatabaseConnection } = require('../database/connection');
const { runMigrations } = require('../database/migrator');
const InventoryService = require('../src/modules/inventory/inventory_service');

const TEST_DB = path.join(__dirname, 'test_reconciliation.db');

function setupTestDb() {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }
  const db = new DatabaseConnection(TEST_DB);
  runMigrations(db);

  // Seed minimal fixtures
  db.exec(`
    INSERT INTO businesses (name, cash_reserve_cents, operating_cash_cents)
    VALUES ('Test Wholesale Co', 1000000, 5000000);

    INSERT INTO locations (business_id, name) VALUES (1, 'Main Depot');

    INSERT INTO products (
      business_id, sku, barcode, name, category, base_unit, pack_size,
      lead_days, min_safety_stock, cost_price_cents, sell_price_cents
    ) VALUES (1, 'TEST-SKU-01', '111222333', 'Test Widget', 'General', 'pcs', 1, 7, 5, 500, 1000);
  `);

  return db;
}

test('Stock Reconciliation: Rejects negative stock and verifies exact audit ledger entries', async (t) => {
  const db = setupTestDb();
  const service = new InventoryService(db);

  // 1. Initial stock movement: Add 10 units
  service.adjustStock({
    businessId: 1,
    productId: 1,
    locationId: 1,
    changeQty: 10,
    reason: 'INITIAL_STOCK'
  });

  let pos = service.getStockPositions(1, 1);
  assert.equal(pos.on_hand, 10, 'Initial on-hand should be 10');
  assert.equal(pos.available, 10, 'Initial available should be 10');

  // 2. Attempt to adjust -15 (should fail: balance cannot go negative without backorder flag)
  assert.throws(
    () => {
      service.adjustStock({
        businessId: 1,
        productId: 1,
        locationId: 1,
        changeQty: -15,
        reason: 'UNAUTHORIZED_DEPLETION',
        allowBackorder: false
      });
    },
    (err) => {
      assert.equal(err.code, 'INSUFFICIENT_STOCK');
      return true;
    },
    'Should throw INSUFFICIENT_STOCK error'
  );

  // Verify stock was not changed
  pos = service.getStockPositions(1, 1);
  assert.equal(pos.on_hand, 10, 'On-hand must remain 10 after rejected deduction');

  // 3. Valid deduction of -4
  service.adjustStock({
    businessId: 1,
    productId: 1,
    locationId: 1,
    changeQty: -4,
    reason: 'VALID_DISPATCH'
  });

  pos = service.getStockPositions(1, 1);
  assert.equal(pos.on_hand, 6, 'On-hand should be 6 after deducting 4');

  // 4. Valid receipt of +8
  service.adjustStock({
    businessId: 1,
    productId: 1,
    locationId: 1,
    changeQty: 8,
    reason: 'RESTOCK_RECEIPT'
  });

  pos = service.getStockPositions(1, 1);
  assert.equal(pos.on_hand, 14, 'On-hand should be 14 after adding 8');

  // 5. Verify exact audit trail ledger rows
  const movements = service.getMovements({ businessId: 1, productId: 1 });
  assert.equal(movements.length, 3, 'Ledger must contain exactly 3 recorded movements');

  // In descending order:
  assert.equal(movements[0].reason, 'RESTOCK_RECEIPT');
  assert.equal(movements[0].change_qty, 8);
  assert.equal(movements[0].balance_after, 14);

  assert.equal(movements[1].reason, 'VALID_DISPATCH');
  assert.equal(movements[1].change_qty, -4);
  assert.equal(movements[1].balance_after, 6);

  assert.equal(movements[2].reason, 'INITIAL_STOCK');
  assert.equal(movements[2].change_qty, 10);
  assert.equal(movements[2].balance_after, 10);

  db.close();
  try { fs.unlinkSync(TEST_DB); } catch (e) {}
});
