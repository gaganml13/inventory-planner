/**
 * operational_crud_and_intelligence.test.js
 *
 * Verifies:
 * - Run Pipeline returns clean structured JSON without unformatted HTML
 * - Generate Draft PO handles various cost formats, binds supplier/location, updates status to ORDERED
 * - Product CRUD (Edit, Delete)
 * - Contacts CRUD (Create, Edit, Delete)
 * - Stock Adjustments with custom count & audit reasons
 * - Metrics includes inventoryAssetValueCents and topReorderPriorities
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

const TEST_DB = path.join(__dirname, 'test_operational.db');

function setupTestDb() {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }
  const db = new DatabaseConnection(TEST_DB);
  runMigrations(db);
  seedDatabase(db);
  return db;
}

test('Operational Features & Resilient APIs', async (t) => {
  const db = setupTestDb();
  const app = createApp(db);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Authenticate as guest
    const guestRes = await fetch(`${baseUrl}/api/auth/guest`, { method: 'POST' });
    const guestData = await guestRes.json();
    const cookie = guestRes.headers.get('set-cookie').split(';')[0];

    // 2. Metrics check (inventory asset value & top reorder priorities)
    const metricsRes = await fetch(`${baseUrl}/api/metrics`, {
      headers: { 'Cookie': cookie }
    });
    assert.equal(metricsRes.status, 200);
    const metrics = await metricsRes.json();
    assert.ok(metrics.inventoryAssetValueCents > 0, 'Inventory asset value must be computed');
    assert.ok(Array.isArray(metrics.topReorderPriorities), 'Top reorder priorities must be an array');
    assert.ok(metrics.topReorderPriorities.length > 0);
    assert.ok(metrics.topReorderPriorities[0].sku);
    assert.ok(metrics.topReorderPriorities[0].reorderPoint !== undefined);

    // 3. Run Pipeline via API: must return valid JSON (no unexpected HTML error)
    const pipelineRes = await fetch(`${baseUrl}/api/intelligence/recommendations/recompute`, {
      method: 'POST',
      headers: { 'Cookie': cookie }
    });
    assert.equal(pipelineRes.status, 200);
    const pipelineData = await pipelineRes.json();
    assert.equal(pipelineData.success, true);
    assert.ok(Array.isArray(pipelineData.recommendations));

    // 3b. Verify POST /api/intelligence/run-pipeline safe execution (returns valid JSON, never unhandled HTML)
    const runPipelineRes = await fetch(`${baseUrl}/api/intelligence/run-pipeline`, {
      method: 'POST',
      headers: { 'Cookie': cookie }
    });
    assert.equal(runPipelineRes.status, 200);
    assert.ok(runPipelineRes.headers.get('content-type').includes('application/json'));
    const runPipelineData = await runPipelineRes.json();
    assert.ok(typeof runPipelineData === 'object');
    assert.ok('success' in runPipelineData);

    // 3c. Verify GET /api/intelligence/model-diagnostics
    const diagRes = await fetch(`${baseUrl}/api/intelligence/model-diagnostics`, {
      headers: { 'Cookie': cookie }
    });
    assert.equal(diagRes.status, 200);
    const diagData = await diagRes.json();
    assert.equal(diagData.success, true);
    assert.ok(diagData.modelName);
    assert.ok(typeof diagData.trainingRecords === 'number');
    assert.ok(typeof diagData.improvementPct === 'number');
    assert.ok(diagData.status);

    // 4. Forecast API: verify real numbers for p50_qty / expected_demand
    const positionsRes = await fetch(`${baseUrl}/api/inventory/positions`, {
      headers: { 'Cookie': cookie }
    });
    const positions = await positionsRes.json();
    const sampleProduct = positions[0];

    const fcRes = await fetch(`${baseUrl}/api/intelligence/forecasts/${sampleProduct.product_id}`, {
      headers: { 'Cookie': cookie }
    });
    assert.equal(fcRes.status, 200);
    const fcData = await fcRes.json();
    assert.ok(fcData.forecast);
    assert.ok(typeof fcData.forecast.p50_qty === 'number' && !isNaN(fcData.forecast.p50_qty));
    assert.ok(typeof fcData.forecast.expected_demand === 'number' && !isNaN(fcData.forecast.expected_demand));

    // 5. Generate Draft PO Workflow
    const recsRes = await fetch(`${baseUrl}/api/intelligence/recommendations`, {
      headers: { 'Cookie': cookie }
    });
    const recs = await recsRes.json();
    const candidate = recs.find(r => r.status === 'PENDING') || recs[0];

    const poRes = await fetch(`${baseUrl}/api/intelligence/recommendations/${candidate.id}/create-po`, {
      method: 'POST',
      headers: { 'Cookie': cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        estimated_cost_cents: "$24.50" // test currency string parsing
      })
    });
    assert.equal(poRes.status, 201);
    const poData = await poRes.json();
    assert.equal(poData.success, true);
    assert.ok(poData.orderNumber.startsWith('PO-'));
    assert.equal(poData.order.type, 'PURCHASE');
    assert.equal(poData.order.status, 'DRAFT');

    // Verify recommendation status updated to ORDERED in database
    const updatedRecsRes = await fetch(`${baseUrl}/api/intelligence/recommendations`, {
      headers: { 'Cookie': cookie }
    });
    const updatedRecs = await updatedRecsRes.json();
    const updatedCandidate = updatedRecs.find(r => r.id === candidate.id);
    assert.equal(updatedCandidate.status, 'ORDERED');

    // 6. Product CRUD: Edit & Delete
    // Create temporary product to edit and delete
    const createProdRes = await fetch(`${baseUrl}/api/inventory/products`, {
      method: 'POST',
      headers: { 'Cookie': cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: 'TEST-CRUD-01',
        name: 'Test Item for CRUD',
        category: 'Testing',
        cost_price_cents: 500,
        sell_price_cents: 1200,
        pack_size: 5,
        lead_days: 10,
        min_safety_stock: 15,
        initial_stock: 20
      })
    });
    assert.equal(createProdRes.status, 201);
    const createdProd = await createProdRes.json();
    const prodId = createdProd.product_id;

    // Edit Product
    const editProdRes = await fetch(`${baseUrl}/api/inventory/products/${prodId}`, {
      method: 'PUT',
      headers: { 'Cookie': cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: 'TEST-CRUD-01-EDIT',
        name: 'Updated Item Title',
        category: 'Hardware',
        cost_price_cents: 650,
        sell_price_cents: 1500,
        pack_size: 10,
        lead_days: 14,
        min_safety_stock: 25
      })
    });
    assert.equal(editProdRes.status, 200);
    const editedProd = await editProdRes.json();
    assert.equal(editedProd.sku, 'TEST-CRUD-01-EDIT');
    assert.equal(editedProd.name, 'Updated Item Title');
    assert.equal(editedProd.pack_size, 10);
    assert.equal(editedProd.lead_days, 14);

    // Delete Product
    const deleteProdRes = await fetch(`${baseUrl}/api/inventory/products/${prodId}`, {
      method: 'DELETE',
      headers: { 'Cookie': cookie }
    });
    assert.equal(deleteProdRes.status, 200);
    const delData = await deleteProdRes.json();
    assert.equal(delData.success, true);

    // Verify deleted from positions
    const checkDeletedRes = await fetch(`${baseUrl}/api/inventory/positions/${prodId}`, {
      headers: { 'Cookie': cookie }
    });
    assert.equal(checkDeletedRes.status, 404);

    // 7. Contacts CRUD (Create, Edit, Delete)
    const createContactRes = await fetch(`${baseUrl}/api/contacts`, {
      method: 'POST',
      headers: { 'Cookie': cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'SUPPLIER',
        name: 'Acme Test Supplier',
        email: 'acme@test.example.com',
        phone: '+1-555-9988',
        credit_limit_cents: 2500000,
        payment_terms_days: 45
      })
    });
    assert.equal(createContactRes.status, 201);
    const createdContact = await createContactRes.json();
    const contactId = createdContact.id;

    // Edit Contact
    const editContactRes = await fetch(`${baseUrl}/api/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Cookie': cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme Supplier Global Inc',
        payment_terms_days: 60
      })
    });
    assert.equal(editContactRes.status, 200);
    const editedContact = await editContactRes.json();
    assert.equal(editedContact.name, 'Acme Supplier Global Inc');
    assert.equal(editedContact.payment_terms_days, 60);

    // Delete Contact
    const delContactRes = await fetch(`${baseUrl}/api/contacts/${contactId}`, {
      method: 'DELETE',
      headers: { 'Cookie': cookie }
    });
    assert.equal(delContactRes.status, 200);
    const delContactData = await delContactRes.json();
    assert.equal(delContactData.success, true);

    // 8. Stock Adjustment with Custom Count & Audit Reason
    const preAdjustRes = await fetch(`${baseUrl}/api/inventory/positions/${sampleProduct.product_id}`, {
      headers: { 'Cookie': cookie }
    });
    const currentSampleProd = await preAdjustRes.json();

    const adjustRes = await fetch(`${baseUrl}/api/inventory/adjust`, {
      method: 'POST',
      headers: { 'Cookie': cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: sampleProduct.product_id,
        new_on_hand: currentSampleProd.on_hand + 5,
        reason: 'Physical Recount'
      })
    });
    assert.equal(adjustRes.status, 200);
    const adjustedProd = await adjustRes.json();
    assert.equal(adjustedProd.on_hand, currentSampleProd.on_hand + 5);

  } finally {
    server.close();
  }
});
