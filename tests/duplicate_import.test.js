/**
 * duplicate_import.test.js
 *
 * Verifies CSV re-imports with identical line hashes are blocked
 * without partial database mutations (atomic transaction rollback).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { DatabaseConnection } = require('../database/connection');
const { runMigrations } = require('../database/migrator');
const ImportService = require('../src/modules/data/import_service');

const TEST_DB = path.join(__dirname, 'test_import.db');

function setupTestDb() {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }
  const db = new DatabaseConnection(TEST_DB);
  runMigrations(db);

  db.exec(`
    INSERT INTO businesses (name) VALUES ('Import Test Wholesale Corp');
  `);

  return db;
}

test('Duplicate Import Guard: Blocks duplicate line hashes and rolls back without partial mutations', async (t) => {
  const db = setupTestDb();
  const service = new ImportService(db);

  const initialCsv = `sku,barcode,name,category,base_unit,pack_size,lead_days,min_safety_stock,cost_price_cents,sell_price_cents
IMP-001,BAR001,Import Item Alpha,Hardware,pcs,1,7,10,500,1200
IMP-002,BAR002,Import Item Beta,Hardware,pcs,5,10,20,800,1800
IMP-003,BAR003,Import Item Gamma,Hardware,pcs,2,5,15,300,750`;

  // 1. Initial valid import
  const res1 = service.importProducts({
    businessId: 1,
    csvText: initialCsv,
    sourceTag: 'UCI_RETAIL'
  });

  assert.equal(res1.success, true);
  assert.equal(res1.importedCount, 3);

  // Verify exactly 3 products and 3 hashes exist in DB
  const prodCount1 = db.prepare('SELECT COUNT(*) as c FROM products WHERE business_id = 1').get().c;
  const hashCount1 = db.prepare('SELECT COUNT(*) as c FROM data_import_hashes WHERE business_id = 1').get().c;
  assert.equal(prodCount1, 3);
  assert.equal(hashCount1, 3);

  // 2. Attempt second import where line 2 is identical to IMP-002 from previous import
  const duplicateCsv = `sku,barcode,name,category,base_unit,pack_size,lead_days,min_safety_stock,cost_price_cents,sell_price_cents
IMP-004,BAR004,Import Item Delta,Hardware,pcs,1,7,10,900,2000
IMP-002,BAR002,Import Item Beta,Hardware,pcs,5,10,20,800,1800
IMP-005,BAR005,Import Item Epsilon,Hardware,pcs,1,7,10,400,900`;

  // Should throw DUPLICATE_IMPORT_RECORD error and completely roll back IMP-004
  assert.throws(
    () => {
      service.importProducts({
        businessId: 1,
        csvText: duplicateCsv,
        sourceTag: 'UCI_RETAIL'
      });
    },
    (err) => {
      assert.equal(err.code, 'DUPLICATE_IMPORT_RECORD');
      return true;
    },
    'Should reject duplicate import record'
  );

  // 3. Verify ATOMIC ROLLBACK: No products were added from duplicate batch (IMP-004 must not exist)
  const prodCountAfter = db.prepare('SELECT COUNT(*) as c FROM products WHERE business_id = 1').get().c;
  const hashCountAfter = db.prepare('SELECT COUNT(*) as c FROM data_import_hashes WHERE business_id = 1').get().c;

  assert.equal(prodCountAfter, 3, 'Product count must remain strictly 3 due to atomic rollback');
  assert.equal(hashCountAfter, 3, 'Hash count must remain strictly 3 due to atomic rollback');

  const imp4 = db.prepare("SELECT id FROM products WHERE sku = 'IMP-004'").get();
  assert.equal(imp4, undefined, 'IMP-004 must NOT be committed to database');

  db.close();
  try { fs.unlinkSync(TEST_DB); } catch (e) {}
});
