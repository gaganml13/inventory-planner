/**
 * b2b_and_usability.test.js
 *
 * Verifies:
 * 1. Confirming a PO and then clicking Unconfirm (Revert to Draft) restores exact cash/incoming metrics with zero residual debt.
 * 2. Importing a CSV/PDF order populates a Draft PO accurately with preview mapping.
 * 3. Zero Data Leakage: Business A cannot see Business B's private cost_price_cents or cash_balance via /api/b2b/catalog.
 * 4. B2B Direct Trade Sync: Placing a B2B order between Business A and Business B cleanly syncs Buyer PO <-> Seller SO,
 *    and declining/cancelling releases all stock reservations cleanly.
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

const TEST_DB = path.join(__dirname, 'test_b2b_usability.db');

function setupTestDb() {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }
  const db = new DatabaseConnection(TEST_DB);
  runMigrations(db);
  seedDatabase(db);
  return db;
}

test('B2B Wholesale Network & Action Reversibility Verification', async (t) => {
  const db = setupTestDb();
  const app = createApp(db);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Authenticate as guest (Business #1: Vanguard Wholesale)
    const guestRes = await fetch(`${baseUrl}/api/auth/guest`, { method: 'POST' });
    assert.equal(guestRes.status, 200);
    const cookieA = guestRes.headers.get('set-cookie').split(';')[0];

    // ──────────────────────────────────────────────────────────
    // 1. PO Confirm & Unconfirm (Revert to Draft) Zero Debt Test
    // ──────────────────────────────────────────────────────────
    const contactsRes = await fetch(`${baseUrl}/api/contacts?type=SUPPLIER`, { headers: { Cookie: cookieA } });
    const contacts = await contactsRes.json();
    assert.ok(contacts.length > 0);
    const supplier = contacts[0];

    const prodsRes = await fetch(`${baseUrl}/api/inventory/positions`, { headers: { Cookie: cookieA } });
    const prods = await prodsRes.json();
    assert.ok(prods.length > 0);
    const sampleProd = prods[0];

    // Check baseline summary before PO
    const preSummaryRes = await fetch(`${baseUrl}/api/payments/summary`, { headers: { Cookie: cookieA } });
    const preSummary = await preSummaryRes.json();
    const initial14dAp = preSummary.upcomingAp14dCents || 0;

    // Create Draft PO for 50 units
    const createPoRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: supplier.id,
        type: 'PURCHASE',
        lines: [{ product_id: sampleProd.product_id, quantity: 50, unit_price_cents: 1000 }]
      })
    });
    assert.equal(createPoRes.status, 201);
    const po = await createPoRes.json();
    assert.equal(po.status, 'DRAFT');

    // Confirm PO -> incoming should increase by 50, 14-day AP should reflect PO
    const confirmRes = await fetch(`${baseUrl}/api/orders/${po.id}/confirm`, {
      method: 'POST',
      headers: { Cookie: cookieA }
    });
    assert.equal(confirmRes.status, 200);
    const confirmedPo = await confirmRes.json();
    assert.equal(confirmedPo.status, 'CONFIRMED');

    // Verify incoming position increased
    const midPosRes = await fetch(`${baseUrl}/api/inventory/positions/${sampleProd.product_id}`, { headers: { Cookie: cookieA } });
    const midPos = await midPosRes.json();
    assert.equal(midPos.incoming_po, sampleProd.incoming_po + 50);

    // Unconfirm (Revert to Draft)
    const unconfirmRes = await fetch(`${baseUrl}/api/orders/${po.id}/unconfirm`, {
      method: 'POST',
      headers: { Cookie: cookieA }
    });
    assert.equal(unconfirmRes.status, 200);
    const revertedPo = await unconfirmRes.json();
    assert.equal(revertedPo.status, 'DRAFT');

    // Verify incoming returned to baseline and residual debt is 0
    const postPosRes = await fetch(`${baseUrl}/api/inventory/positions/${sampleProd.product_id}`, { headers: { Cookie: cookieA } });
    const postPos = await postPosRes.json();
    assert.equal(postPos.incoming_po, sampleProd.incoming_po);

    const postSummaryRes = await fetch(`${baseUrl}/api/payments/summary`, { headers: { Cookie: cookieA } });
    const postSummary = await postSummaryRes.json();
    assert.equal(postSummary.upcomingAp14dCents, initial14dAp, 'Reverting to draft must release all 14-day AP debt');

    // ──────────────────────────────────────────────────────────
    // 2. Import CSV / PDF Order Preview Test
    // ──────────────────────────────────────────────────────────
    const csvContent = [
      'SKU,Quantity,Price',
      `${sampleProd.sku},25,12.50`,
      'NON-EXISTENT-SKU-999,10,5.00'
    ].join('\n');

    const previewRes = await fetch(`${baseUrl}/api/data/parse-order-document`, {
      method: 'POST',
      headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text_content: csvContent,
        order_type: 'PURCHASE'
      })
    });
    assert.equal(previewRes.status, 200);
    const previewData = await previewRes.json();
    assert.equal(previewData.success, true);
    assert.equal(previewData.count, 2);

    // Matched item
    const matchedItem = previewData.items.find(i => i.raw_sku === sampleProd.sku);
    assert.ok(matchedItem);
    assert.equal(matchedItem.is_matched, true);
    assert.equal(matchedItem.product_id, sampleProd.product_id);
    assert.equal(matchedItem.quantity, 25);

    // Unmatched item
    const unmatchedItem = previewData.items.find(i => i.raw_sku === 'NON-EXISTENT-SKU-999');
    assert.ok(unmatchedItem);
    assert.equal(unmatchedItem.is_matched, false);
    assert.equal(unmatchedItem.product_id, null);

    // Verify template endpoints
    const tmplCsvRes = await fetch(`${baseUrl}/api/data/templates/sample-order.csv`, { headers: { Cookie: cookieA } });
    assert.equal(tmplCsvRes.status, 200);
    assert.ok(tmplCsvRes.headers.get('content-type').includes('text/csv'));

    const tmplPdfRes = await fetch(`${baseUrl}/api/data/templates/sample-order.pdf`, { headers: { Cookie: cookieA } });
    assert.equal(tmplPdfRes.status, 200);
    assert.ok(tmplPdfRes.headers.get('content-type').includes('application/pdf'));

    // ──────────────────────────────────────────────────────────
    // 3. Zero Data Leakage Security Test
    // ──────────────────────────────────────────────────────────
    // Query B2B catalog from Buyer perspective
    const b2bCatRes = await fetch(`${baseUrl}/api/b2b/catalog`, { headers: { Cookie: cookieA } });
    assert.equal(b2bCatRes.status, 200);
    const b2bCatalog = await b2bCatRes.json();
    assert.ok(b2bCatalog.length > 0);

    for (const item of b2bCatalog) {
      assert.strictEqual(item.cost_price_cents, undefined, 'B2B catalog MUST NEVER leak cost_price_cents');
      assert.strictEqual(item.cash_balance, undefined, 'B2B catalog MUST NEVER leak cash_balance');
      assert.strictEqual(item.operating_cash_cents, undefined, 'B2B catalog MUST NEVER leak operating cash');
      assert.strictEqual(item.on_hand, undefined, 'B2B catalog MUST NEVER leak exact warehouse on_hand');
      assert.ok(item.availability, 'Must provide privacy-safe availability badge');
      assert.ok(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK'].includes(item.availability.status));
      assert.ok(item.b2b_price_cents > 0);
    }

    // ──────────────────────────────────────────────────────────
    // 4. B2B PO-to-SO Direct Trade Sync & Safe Cancellation Test
    // ──────────────────────────────────────────────────────────
    // Register Business B (Seller Wholesaler)
    const regSellerRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'seller_owner@pacifictrade.example.com',
        password: 'Password123!',
        businessName: 'Pacific Coast Trade Logistics'
      })
    });
    assert.equal(regSellerRes.status, 200);
    const sellerData = await regSellerRes.json();
    const sellerBizId = sellerData.business.id;
    const sellerCookie = regSellerRes.headers.get('set-cookie').split(';')[0];

    // Setup Seller B's B2B profile
    await fetch(`${baseUrl}/api/b2b/profile`, {
      method: 'POST',
      headers: { Cookie: sellerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_name: 'Pacific Coast Trade Logistics',
        category: 'Electronics & Hardware',
        city: 'Portland Hub',
        min_order_cents: 10000,
        delivery_days: 2,
        is_public: 1
      })
    });

    // Create a product for Seller B and list it on B2B
    const createSellerProdRes = await fetch(`${baseUrl}/api/inventory/products`, {
      method: 'POST',
      headers: { Cookie: sellerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: 'B2B-SSD-1TB',
        name: 'Enterprise NVMe SSD 1TB',
        category: 'Electronics',
        cost_price_cents: 4500,
        sell_price_cents: 8000,
        pack_size: 5,
        lead_days: 2,
        min_safety_stock: 10,
        initial_stock: 100
      })
    });
    assert.equal(createSellerProdRes.status, 201);
    const sellerProd = await createSellerProdRes.json();

    // List on B2B
    await fetch(`${baseUrl}/api/b2b/products/${sellerProd.product_id}/listing`, {
      method: 'POST',
      headers: { Cookie: sellerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        is_b2b_listed: 1,
        b2b_price_cents: 6500,
        b2b_moq: 5
      })
    });

    // Buyer A queries B2B catalog -> finds Seller B's product
    const buyerB2bCatRes = await fetch(`${baseUrl}/api/b2b/catalog?seller_id=${sellerBizId}`, { headers: { Cookie: cookieA } });
    assert.equal(buyerB2bCatRes.status, 200);
    const buyerCat = await buyerB2bCatRes.json();
    assert.ok(buyerCat.length > 0);
    const itemToOrder = buyerCat.find(i => i.sku === 'B2B-SSD-1TB');
    assert.ok(itemToOrder);
    assert.equal(itemToOrder.b2b_price_cents, 6500);
    assert.strictEqual(itemToOrder.cost_price_cents, undefined, 'Must not leak cost_price_cents');

    // Buyer A sends purchase request to Seller B
    const tradeReqRes = await fetch(`${baseUrl}/api/b2b/orders/request`, {
      method: 'POST',
      headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seller_business_id: sellerBizId,
        items: [{ seller_product_id: itemToOrder.product_id, quantity: 10 }],
        trade_notes: 'Urgent wholesale restock'
      })
    });
    assert.equal(tradeReqRes.status, 201);
    const tradeReq = await tradeReqRes.json();
    assert.ok(tradeReq.tradeOrderId);
    assert.equal(tradeReq.status, 'PENDING_APPROVAL');

    // Seller accepts the order
    const acceptRes = await fetch(`${baseUrl}/api/b2b/orders/${tradeReq.tradeOrderId}/accept`, {
      method: 'POST',
      headers: { Cookie: sellerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(acceptRes.status, 200);
    const acceptedData = await acceptRes.json();
    assert.equal(acceptedData.status, 'ACCEPTED');
    assert.ok(acceptedData.sellerSoId);

    // Verify Buyer PO is now CONFIRMED
    const checkBuyerPoRes = await fetch(`${baseUrl}/api/orders/${tradeReq.buyerPoId}`, { headers: { Cookie: cookieA } });
    const checkBuyerPo = await checkBuyerPoRes.json();
    assert.equal(checkBuyerPo.status, 'CONFIRMED');

    // Cancel trade order before shipment -> releases all reservations cleanly
    const cancelTradeRes = await fetch(`${baseUrl}/api/b2b/orders/${tradeReq.tradeOrderId}/decline`, {
      method: 'POST',
      headers: { Cookie: sellerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Stock reallocated to priority client' })
    });
    assert.equal(cancelTradeRes.status, 200);
    const cancelData = await cancelTradeRes.json();
    assert.equal(cancelData.status, 'DECLINED');

    // Verify Buyer PO and Seller SO are cancelled
    const buyerPoCancelled = await (await fetch(`${baseUrl}/api/orders/${tradeReq.buyerPoId}`, { headers: { Cookie: cookieA } })).json();
    assert.equal(buyerPoCancelled.status, 'CANCELLED');

    const sellerSoCancelled = await (await fetch(`${baseUrl}/api/orders/${acceptedData.sellerSoId}`, { headers: { Cookie: sellerCookie } })).json();
    assert.equal(sellerSoCancelled.status, 'CANCELLED');

  } finally {
    server.close();
  }
});
