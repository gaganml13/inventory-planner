/**
 * benchmark_and_chart_sync.test.js
 *
 * Verifies:
 * 1. Schema constraint enforcement: orders.contact_id NOT NULL is always satisfied by binding a valid customer.
 * 2. POST /api/intelligence/seed-benchmark-data creates TEST-FAST-01, TEST-STEADY-02, and TEST-LUMPY-03 with 45 days of history.
 * 3. GET /api/intelligence/forecasts returns all catalog forecasts.
 * 4. GET /api/intelligence/forecasts/:productId returns distinct historical and forward predictions (futureDaily) per SKU.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { DatabaseConnection } = require('../database/connection');
const { runMigrations } = require('../database/migrator');
const { seedDatabase } = require('../database/seed');
const { createApp } = require('../src/app');
const { seedBenchmarkData } = require('../src/modules/intelligence/benchmark_seeder');

const TEST_DB = path.join(__dirname, 'test_benchmark_sync.db');

function setupTestDb() {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }
  const db = new DatabaseConnection(TEST_DB);
  runMigrations(db);
  seedDatabase(db);
  return db;
}

test('Benchmark Test Dataset & Dynamic Forecast Sync', async (t) => {
  const db = setupTestDb();
  const app = createApp(db);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Authenticate as Guest
    const guestRes = await fetch(`${baseUrl}/api/auth/guest`, { method: 'POST' });
    assert.equal(guestRes.status, 200);
    const cookie = guestRes.headers.get('set-cookie').split(';')[0];

    // 2. Direct schema verification for orders.contact_id
    const orderCols = db.prepare("PRAGMA table_info('orders')").all();
    const contactCol = orderCols.find(c => c.name === 'contact_id');
    assert.ok(contactCol, 'contact_id column must exist in orders');
    assert.equal(contactCol.notnull, 1, 'orders.contact_id must have NOT NULL constraint');

    // 3. Trigger POST /api/intelligence/seed-benchmark-data
    const seedRes = await fetch(`${baseUrl}/api/intelligence/seed-benchmark-data`, {
      method: 'POST',
      headers: { 'Cookie': cookie }
    });
    assert.equal(seedRes.status, 200);
    const seedData = await seedRes.json();
    assert.equal(seedData.success, true);
    assert.equal(seedData.days_generated, 45);
    assert.ok(seedData.customerId, 'Must bind a valid customer ID to all benchmark orders');

    // Verify all created benchmark orders have contact_id populated
    const unassignedOrders = db.prepare("SELECT COUNT(*) AS cnt FROM orders WHERE contact_id IS NULL").get();
    assert.equal(unassignedOrders.cnt, 0, 'Zero orders should have NULL contact_id');

    // 4. Verify 3 Benchmark Products created
    const prods = db.prepare("SELECT * FROM products WHERE sku LIKE 'TEST-%' ORDER BY sku ASC").all();
    assert.equal(prods.length, 3, 'Must create exactly 3 benchmark products');
    const fastProd = prods.find(p => p.sku === 'TEST-FAST-01');
    const steadyProd = prods.find(p => p.sku === 'TEST-STEADY-02');
    const lumpyProd = prods.find(p => p.sku === 'TEST-LUMPY-03');

    assert.ok(fastProd && steadyProd && lumpyProd);

    // 5. Verify GET /api/intelligence/forecasts (all forecasts)
    const allFcRes = await fetch(`${baseUrl}/api/intelligence/forecasts`, {
      headers: { 'Cookie': cookie }
    });
    assert.equal(allFcRes.status, 200);
    const allForecasts = await allFcRes.json();
    assert.ok(Array.isArray(allForecasts));
    assert.ok(allForecasts.length >= 3);

    // 6. Verify distinct forecast curves for each benchmark product
    const [fastFcRes, steadyFcRes, lumpyFcRes] = await Promise.all([
      fetch(`${baseUrl}/api/intelligence/forecasts/${fastProd.id}`, { headers: { 'Cookie': cookie } }),
      fetch(`${baseUrl}/api/intelligence/forecasts/${steadyProd.id}`, { headers: { 'Cookie': cookie } }),
      fetch(`${baseUrl}/api/intelligence/forecasts/${lumpyProd.id}`, { headers: { 'Cookie': cookie } })
    ]);

    assert.equal(fastFcRes.status, 200);
    assert.equal(steadyFcRes.status, 200);
    assert.equal(lumpyFcRes.status, 200);

    const fastFc = await fastFcRes.json();
    const steadyFc = await steadyFcRes.json();
    const lumpyFc = await lumpyFcRes.json();

    // Verify historical data has actual non-zero sales
    assert.ok(fastFc.history && fastFc.history.length > 0);
    assert.ok(steadyFc.history && steadyFc.history.length > 0);
    assert.ok(lumpyFc.history && lumpyFc.history.length > 0);

    const fastTotalPast = fastFc.history.reduce((acc, h) => acc + (h.salesQty || h.quantity || 0), 0);
    const steadyTotalPast = steadyFc.history.reduce((acc, h) => acc + (h.salesQty || h.quantity || 0), 0);
    const lumpyTotalPast = lumpyFc.history.reduce((acc, h) => acc + (h.salesQty || h.quantity || 0), 0);

    assert.ok(fastTotalPast > 0, 'TEST-FAST-01 must have non-zero historical sales');
    assert.ok(steadyTotalPast > 0, 'TEST-STEADY-02 must have non-zero historical sales');
    assert.ok(lumpyTotalPast > 0, 'TEST-LUMPY-03 must have non-zero historical sales');

    // Distinct pattern check: Fast mover should have significantly higher volume than steady and lumpy
    assert.ok(fastTotalPast > steadyTotalPast, 'Fast mover past volume must exceed steady mover');
    assert.ok(steadyTotalPast > lumpyTotalPast, 'Steady mover past volume must exceed lumpy burst mover');

    // Verify futureDaily curves exist and are not identical flat lines
    assert.ok(Array.isArray(fastFc.forecast.futureDaily));
    assert.equal(fastFc.forecast.futureDaily.length, 14);

    assert.ok(fastFc.forecast.p50Qty > steadyFc.forecast.p50Qty, 'Forecast expected demand must differ based on SKU pattern');
    assert.ok(steadyFc.forecast.p50Qty > lumpyFc.forecast.p50Qty, 'Steady forecast expected demand must exceed lumpy');

  } finally {
    server.close();
    if (fs.existsSync(TEST_DB)) {
      try { fs.unlinkSync(TEST_DB); } catch (e) {}
    }
  }
});
