/**
 * assistant.test.js — Vanguard Copilot & AI Assistant Verification Suite
 *
 * Tests:
 * 1. GET /api/assistant/context verifies tenant isolation and calculated budget.
 * 2. POST /api/assistant/ask answers purchasing budget queries matching database exactly.
 * 3. POST /api/assistant/ask answers SKU-specific stock lookups with on-hand & available balances.
 * 4. POST /api/assistant/ask explains ML demand forecasting math and Croston/SBA model selection.
 * 5. POST /api/assistant/ask explains blind count audits and monetary variance governance.
 * 6. Validates zero hallucination and strict RAG context grounding.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { DatabaseConnection } = require('../database/connection');
const { runMigrations } = require('../database/migrator');
const { createApp } = require('../src/app');
const AuthService = require('../src/modules/auth/auth_service');

const TEST_DB = path.join(__dirname, 'test_assistant.db');

function setupTestDb() {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (_) {}
  }
  const db = new DatabaseConnection(TEST_DB);
  runMigrations(db);

  // Tenant 1
  db.exec(`
    INSERT INTO businesses (id, name, currency, operating_cash_cents, cash_reserve_cents, approval_threshold_cents, default_lead_days)
    VALUES (1, 'Smart Business Analyzer Alpha', 'USD', 6000000, 1500000, 50000, 7);

    INSERT INTO locations (id, business_id, name) VALUES (1, 1, 'Main Depot');

    INSERT INTO users (id, business_id, email, password_hash, role, is_guest)
    VALUES (1, 1, 'alpha_owner@test.com', 'hash', 'OWNER', 0);

    INSERT INTO contacts (id, business_id, name, type) VALUES (1, 1, 'Premier Supplier', 'SUPPLIER');

    -- Products
    INSERT INTO products (id, business_id, sku, barcode, name, category, pack_size, cost_price_cents, sell_price_cents, min_safety_stock, lead_days)
    VALUES 
      (1, 1, 'SKU-FAST-01', 'BAR01', 'High Velocity Microcontroller', 'Electronics', 10, 500, 1500, 20, 7),
      (2, 1, 'SKU-CRIT-02', 'BAR02', 'Heavy Duty Power Inverter', 'Power', 1, 4000, 9500, 15, 14);

    -- Stock Movements (SKU 1 has 50 on-hand, SKU 2 has 5 on-hand -> critical!)
    INSERT INTO stock_movements (business_id, product_id, location_id, change_qty, balance_after, reason, stock_type)
    VALUES 
      (1, 1, 1, 50, 50, 'INITIAL', 'AVAILABLE'),
      (1, 2, 1, 5, 5, 'INITIAL', 'AVAILABLE');

    -- Confirmed PO due within 14 days ($500 = 50,000 cents payable)
    INSERT INTO orders (id, business_id, contact_id, order_number, type, status, due_date, total_cents, paid_cents)
    VALUES (1, 1, 1, 'PO-1001', 'PURCHASE', 'CONFIRMED', date('now', '+5 days'), 50000, 0);

    -- Forecast cache for SKU 1
    INSERT INTO demand_forecasts (business_id, product_id, horizon_days, p50_qty, p90_qty, model_name, uncertainty_score)
    VALUES (1, 1, 30, 120, 175, 'LightGBM-Quantile', 0.12);
  `);

  // Tenant 2 (Isolated)
  db.exec(`
    INSERT INTO businesses (id, name, currency, operating_cash_cents, cash_reserve_cents)
    VALUES (2, 'Isolated Beta Corp', 'EUR', 1000000, 200000);

    INSERT INTO users (id, business_id, email, password_hash, role, is_guest)
    VALUES (2, 2, 'beta_owner@test.com', 'hash', 'OWNER', 0);
  `);

  return db;
}

test('Vanguard Copilot AI Assistant: Live Context & Deterministic RAG Verification', async (t) => {
  const db = setupTestDb();
  const authService = new AuthService(db);

  const session1 = authService.createSession(1, 1);
  const cookie1 = `session=${session1.token}`;

  const session2 = authService.createSession(2, 2);
  const cookie2 = `session=${session2.token}`;

  const app = createApp(db);
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Context Tenant Isolation Check
    await t.test('GET /api/assistant/context enforces tenant isolation and accurate budget math', async () => {
      // Query Tenant 1
      const res1 = await fetch(`${baseUrl}/api/assistant/context`, {
        headers: { Cookie: cookie1 }
      });
      assert.equal(res1.status, 200);
      const data1 = await res1.json();

      assert.equal(data1.success, true);
      assert.equal(data1.businessId, 1);
      assert.equal(data1.business.name, 'Smart Business Analyzer Alpha');
      assert.equal(data1.business.operatingCashCents, 6000000); // $60,000
      assert.equal(data1.business.cashReserveCents, 1500000);   // $15,000
      assert.equal(data1.business.upcomingPayablesCents, 50000); // $500 payable
      // Safe budget = 6,000,000 - 1,500,000 - 50,000 = 4,450,000 cents ($44,500)
      assert.equal(data1.business.safeBudgetCents, 4450000);
      assert.equal(data1.inventorySummary.totalSkus, 2);
      assert.equal(data1.inventorySummary.criticalStockCount, 1); // SKU-CRIT-02 is <= 15
      assert.equal(data1.inventorySummary.criticalSkus[0].sku, 'SKU-CRIT-02');

      // Query Tenant 2 (Isolated)
      const res2 = await fetch(`${baseUrl}/api/assistant/context`, {
        headers: { Cookie: cookie2 }
      });
      assert.equal(res2.status, 200);
      const data2 = await res2.json();

      assert.equal(data2.businessId, 2);
      assert.equal(data2.business.name, 'Isolated Beta Corp');
      assert.equal(data2.inventorySummary.totalSkus, 0); // No leakage from Tenant 1
    });

    // 2. Purchasing Budget Query
    await t.test('POST /api/assistant/ask explains Purchasing Budget with exact live figures', async () => {
      const res = await fetch(`${baseUrl}/api/assistant/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ question: 'What is our safe purchasing budget right now?' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(data.groundedAnswer.includes('$44,500.00'), 'Should contain exact safe budget $44,500.00');
      assert.ok(data.groundedAnswer.includes('$60,000.00'), 'Should state operating cash $60,000.00');
      assert.ok(data.groundedAnswer.includes('$15,000.00'), 'Should state cash reserve $15,000.00');
      assert.ok(data.groundedAnswer.includes('$500.00'), 'Should state upcoming payables $500.00');
      assert.ok(data.suggestedActions.some(a => a.tab === 'purchases'), 'Should suggest purchases tab');
    });

    // 3. Stockout Risk Query
    await t.test('POST /api/assistant/ask identifies critical low-stock SKUs', async () => {
      const res = await fetch(`${baseUrl}/api/assistant/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ question: 'Which SKUs are at risk of stockout?' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(data.groundedAnswer.includes('SKU-CRIT-02'), 'Should identify SKU-CRIT-02');
      assert.ok(data.groundedAnswer.includes('Heavy Duty Power Inverter'));
      assert.ok(data.groundedAnswer.includes('5'), 'Should report 5 units available');
      assert.ok(data.groundedAnswer.includes('15'), 'Should report safety stock 15');
    });

    // 4. Specific SKU Lookup
    await t.test('POST /api/assistant/ask retrieves exact balances for specific SKU', async () => {
      const res = await fetch(`${baseUrl}/api/assistant/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ question: 'Tell me the current stock status of SKU-FAST-01' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(data.groundedAnswer.includes('SKU-FAST-01'));
      assert.ok(data.groundedAnswer.includes('50'), 'Should report on-hand 50 units');
      assert.ok(data.groundedAnswer.includes('$5.00'), 'Should report cost $5.00');
      assert.ok(data.groundedAnswer.includes('$15.00'), 'Should report sell $15.00');
    });

    // 5. ML Forecasting Math
    await t.test('POST /api/assistant/ask explains ML quantile regression & safety stock formula', async () => {
      const res = await fetch(`${baseUrl}/api/assistant/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ question: 'How is safety stock and P50/P90 calculated?' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(data.groundedAnswer.includes('Lead Time Demand'));
      assert.ok(data.groundedAnswer.includes('Safety Stock Buffer'));
      assert.ok(data.groundedAnswer.includes('LightGBM Quantile Regression'));
      assert.ok(data.groundedAnswer.includes('Croston'));
      assert.ok(data.groundedAnswer.includes('P50 = **120**'), 'Should report live forecast for SKU-FAST-01');
    });

    // 6. Blind Count Audit Workflow
    await t.test('POST /api/assistant/ask explains blind count audits and variance thresholds', async () => {
      const res = await fetch(`${baseUrl}/api/assistant/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ question: 'How does a blind count and discrepancy approval work?' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(data.groundedAnswer.includes('Blind Count Mode'));
      assert.ok(data.groundedAnswer.includes('confirmation bias'));
      assert.ok(data.groundedAnswer.includes('$500.00'), 'Should cite configured $500.00 threshold');
      assert.ok(data.groundedAnswer.includes('OWNER'));
    });

    // 7. Unauthenticated guard
    await t.test('Unauthenticated requests are rejected', async () => {
      const res = await fetch(`${baseUrl}/api/assistant/context`);
      assert.equal(res.status, 401);
    });
  } finally {
    server.close();
    try { fs.unlinkSync(TEST_DB); } catch (_) {}
  }
});
