/**
 * e2e_complete_journey.test.js
 *
 * Automated End-to-End Complete Business Lifecycle & Verification Suite.
 *
 * Verifies the full 8-step lifecycle:
 * Step 1: Start with 0 stock on new test SKU ('TEST-E2E-01') and $50,000.00 opening cash.
 * Step 2: Draft PO for 100 units -> verify on_hand = 0 and Free Capital is NOT reduced;
 *         Approve PO -> verify incoming = 100 and 14-day AP obligation created.
 * Step 3: Receive 100 units -> verify on_hand = 100, available = 100, incoming = 0, ledger updated.
 * Step 4: Approve/Reserve Sales Order for 10 units -> verify on_hand = 100, reserved = 10, available = 90.
 * Step 5: Ship 10 units -> verify on_hand = 90, reserved = 0, available = 90, shipment ledger recorded.
 * Step 6: Issue invoice & record partial payment -> verify AR and Cash Available update accurately.
 * Step 7: Supplier payment, customer return, order cancellation, and blind stock count discrepancy
 *         exceeding approval limit ($500) requiring OWNER approval to update ledger.
 * Step 8: Role permission bypass rejection, cross-business isolation, duplicate CSV import rejection,
 *         pack-size rounding, and persistence across server restart.
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
const InventoryService = require('../src/modules/inventory/inventory_service');
const OrderService = require('../src/modules/orders/order_service');
const PaymentService = require('../src/modules/payments/payment_service');
const CycleCountService = require('../src/modules/inventory/cycle_count_service');
const ReorderEngine = require('../src/modules/intelligence/reorder_engine');
const ImportService = require('../src/modules/data/import_service');

const TEST_DB = path.join(__dirname, 'test_e2e_journey.db');

test('E2E Complete Business Journey: Full 8-Step Lifecycle, RBAC, Financials & Isolation', async (t) => {
  // Clean up any previous test database
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }

  let db = new DatabaseConnection(TEST_DB);
  runMigrations(db);

  let app = createApp(db);
  let server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  let port = server.address().port;
  let baseUrl = `http://127.0.0.1:${port}`;

  let ownerCookie = '';
  let warehouseCookie = '';
  let bizId;
  let locId;
  let supplierId;
  let customerId;
  let prodId;
  let poId;
  let soId;
  let ccId;

  try {
    // =========================================================================
    // STEP 1: Start with 0 stock on new test SKU ('TEST-E2E-01') & $50,000.00 cash
    // =========================================================================
    await t.test('Step 1: Setup business with $50,000 opening cash, users, contacts, and 0 stock SKU', async () => {
      // 1. Create Business: $50,000 operating cash, $10,000 minimum reserve, $500 approval threshold
      const bizRes = db.prepare(`
        INSERT INTO businesses (name, currency, cash_reserve_cents, operating_cash_cents, approval_threshold_cents)
        VALUES ('E2E Apex Industrial Supply', 'USD', 1000000, 5000000, 50000)
      `).run();
      bizId = bizRes.lastInsertRowid;

      // 2. Create Location
      const locRes = db.prepare('INSERT INTO locations (business_id, name) VALUES (?, ?)').run(bizId, 'Main Distribution Warehouse');
      locId = locRes.lastInsertRowid;

      // 3. Create Contacts
      const supRes = db.prepare(`
        INSERT INTO contacts (business_id, type, name, payment_terms_days)
        VALUES (?, 'SUPPLIER', 'Apex Direct Components', 14)
      `).run(bizId);
      supplierId = supRes.lastInsertRowid;

      const custRes = db.prepare(`
        INSERT INTO contacts (business_id, type, name, payment_terms_days)
        VALUES (?, 'CUSTOMER', 'Metro Mechanical Systems', 30)
      `).run(bizId);
      customerId = custRes.lastInsertRowid;

      // 4. Create Users (Owner & Warehouse staff)
      const authService = new AuthService(db);
      const ownerHash = authService.hashPassword('Password123!');
      const ownerRes = db.prepare(`
        INSERT INTO users (email, password_hash, name, business_id, role, is_guest, is_active)
        VALUES ('e2e_owner@apexsupply.test', ?, 'Eleanor Owner', ?, 'OWNER', 0, 1)
      `).run(ownerHash, bizId);
      const ownerId = ownerRes.lastInsertRowid;
      const ownerSession = authService.createSession(ownerId, bizId);
      ownerCookie = `session=${ownerSession.token}`;

      const whRes = db.prepare(`
        INSERT INTO users (email, password_hash, name, business_id, role, is_guest, is_active)
        VALUES ('e2e_warehouse@apexsupply.test', ?, 'Wayne Warehouse', ?, 'WAREHOUSE', 0, 1)
      `).run(ownerHash, bizId);
      const whId = whRes.lastInsertRowid;
      const whSession = authService.createSession(whId, bizId);
      warehouseCookie = `session=${whSession.token}`;

      // 5. Create product TEST-E2E-01 with initial_stock = 0
      const prodRes = await fetch(`${baseUrl}/api/inventory/products`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': ownerCookie
        },
        body: JSON.stringify({
          sku: 'TEST-E2E-01',
          name: 'Precision Heavy Actuator Servo',
          category: 'Actuators',
          pack_size: 5,
          lead_days: 7,
          min_safety_stock: 10,
          cost_price_cents: 2500, // $25.00
          sell_price_cents: 6000, // $60.00
          initial_stock: 0,
          location_id: locId
        })
      });
      assert.equal(prodRes.status, 201, 'Product creation should succeed');
      const prodData = await prodRes.json();
      prodId = prodData.product_id || prodData.id;
      assert.equal(prodData.sku, 'TEST-E2E-01');

      // 6. Verify stock position: on_hand = 0, available = 0, incoming = 0, reserved = 0
      const posRes = await fetch(`${baseUrl}/api/inventory/positions/${prodId}`, {
        headers: { 'Cookie': ownerCookie }
      });
      assert.equal(posRes.status, 200);
      const pos = await posRes.json();
      assert.equal(pos.on_hand, 0, 'Initial on_hand must be 0');
      assert.equal(pos.available, 0, 'Initial available must be 0');
      assert.equal(pos.reserved, 0, 'Initial reserved must be 0');
      assert.equal(pos.incoming_po, 0, 'Initial incoming_po must be 0');

      // 7. Verify initial financial positions: $50,000 cash, $10,000 reserve, purchasing budget $40,000
      const finRes = await fetch(`${baseUrl}/api/payments/summary`, {
        headers: { 'Cookie': ownerCookie }
      });
      assert.equal(finRes.status, 200);
      const fin = await finRes.json();
      assert.equal(fin.operatingCashCents, 5000000, 'Operating cash must be $50,000 (5,000,000 cents)');
      assert.equal(fin.cashReserveCents, 1000000, 'Cash reserve must be $10,000 (1,000,000 cents)');
      assert.equal(fin.purchasingBudgetCents, 4000000, 'Safe purchasing budget must be $40,000');
    });

    // =========================================================================
    // STEP 2: Draft PO for 100 units & Approve PO
    // =========================================================================
    await t.test('Step 2: Create Draft PO for 100 units, verify capital NOT reduced; Approve PO -> incoming = 100', async () => {
      // 1. Create Purchase Order in DRAFT status for 100 units ($25.00 * 100 = $2,500 = 250,000 cents)
      const poRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': ownerCookie
        },
        body: JSON.stringify({
          contact_id: supplierId,
          type: 'PURCHASE',
          due_date: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
          notes: 'Standard stock replenishment PO',
          lines: [{
            product_id: prodId,
            quantity: 100,
            pack_quantity: 20,
            unit_price_cents: 2500
          }]
        })
      });
      assert.equal(poRes.status, 201);
      const poData = await poRes.json();
      poId = poData.id;
      assert.equal(poData.status, 'DRAFT', 'Newly created PO must be in DRAFT state');
      assert.equal(poData.total_cents, 250000, 'PO total must be 250,000 cents ($2,500.00)');

      // Verify on_hand = 0 and incoming = 0 (DRAFT PO is not incoming commitment)
      const posRes1 = await fetch(`${baseUrl}/api/inventory/positions/${prodId}`, {
        headers: { 'Cookie': ownerCookie }
      });
      const pos1 = await posRes1.json();
      assert.equal(pos1.on_hand, 0, 'On-hand must still be 0');
      assert.equal(pos1.incoming_po, 0, 'Draft PO must not appear in incoming_po');
      assert.equal(pos1.draft_po, 100, 'Draft PO quantity must be tracked under draft_po');

      // Verify Free Capital is NOT reduced by DRAFT PO
      const finRes1 = await fetch(`${baseUrl}/api/payments/summary`, {
        headers: { 'Cookie': ownerCookie }
      });
      const fin1 = await finRes1.json();
      assert.equal(
        fin1.purchasingBudgetCents,
        4000000,
        'Draft PO must NOT reduce safe purchasing budget before approval'
      );
      assert.equal(fin1.draftPoCommitmentsCents, 250000, 'Draft PO commitments must be tracked separately');

      // 2. Approve PO
      const confirmRes = await fetch(`${baseUrl}/api/orders/${poId}/confirm`, {
        method: 'POST',
        headers: { 'Cookie': ownerCookie }
      });
      assert.equal(confirmRes.status, 200);
      const confirmedPo = await confirmRes.json();
      assert.equal(confirmedPo.status, 'CONFIRMED', 'Order status must move to CONFIRMED');

      // Verify incoming = 100 units
      const posRes2 = await fetch(`${baseUrl}/api/inventory/positions/${prodId}`, {
        headers: { 'Cookie': ownerCookie }
      });
      const pos2 = await posRes2.json();
      assert.equal(pos2.on_hand, 0, 'Physical on_hand remains 0 until goods received');
      assert.equal(pos2.incoming_po, 100, 'Confirmed PO must register incoming_po = 100');
      assert.equal(pos2.available, 0, 'Available stock is still 0');

      // Verify Confirmed 14-day AP now accounts for this PO and reduces purchasing budget
      const finRes2 = await fetch(`${baseUrl}/api/payments/summary`, {
        headers: { 'Cookie': ownerCookie }
      });
      const fin2 = await finRes2.json();
      assert.equal(
        fin2.accountsPayable.upcoming14dCents,
        250000,
        'Confirmed PO due in 7 days must appear in 14-day AP obligation'
      );
      assert.equal(
        fin2.purchasingBudgetCents,
        3750000,
        'Purchasing budget must deduct confirmed 14-day AP ($40,000 - $2,500 = $37,500)'
      );
    });

    // =========================================================================
    // STEP 3: Receive 100 units
    // =========================================================================
    await t.test('Step 3: Receive 100 units -> on_hand = 100, available = 100, incoming = 0', async () => {
      // Fulfill / Receive the purchase order
      const recvRes = await fetch(`${baseUrl}/api/orders/${poId}/fulfill`, {
        method: 'POST',
        headers: { 'Cookie': ownerCookie }
      });
      assert.equal(recvRes.status, 200);
      const fulfilledPo = await recvRes.json();
      assert.equal(fulfilledPo.status, 'FULFILLED', 'PO must be marked FULFILLED');

      // Verify stock positions: on_hand = 100, available = 100, incoming = 0
      const posRes = await fetch(`${baseUrl}/api/inventory/positions/${prodId}`, {
        headers: { 'Cookie': ownerCookie }
      });
      const pos = await posRes.json();
      assert.equal(pos.on_hand, 100, 'Physical on_hand must be exactly 100');
      assert.equal(pos.available, 100, 'Available stock must be 100');
      assert.equal(pos.incoming_po, 0, 'Incoming PO must reset to 0 after receipt');

      // Verify immutable stock ledger entry exists
      const movRes = await fetch(`${baseUrl}/api/inventory/movements?product_id=${prodId}`, {
        headers: { 'Cookie': ownerCookie }
      });
      assert.equal(movRes.status, 200);
      const movements = await movRes.json();
      assert.ok(movements.length >= 1, 'Stock movement ledger must contain the receipt');
      const latestMov = movements[0];
      assert.equal(latestMov.change_qty, 100);
      assert.equal(latestMov.balance_after, 100);
      assert.equal(latestMov.reason, 'PURCHASE_RECEIPT');
    });

    // =========================================================================
    // STEP 4: Approve/Reserve Sales Order for 10 units
    // =========================================================================
    await t.test('Step 4: Create & Approve Sales Order for 10 units -> on_hand = 100, reserved = 10, available = 90', async () => {
      // Create Sales Order for 10 units ($60.00 each = $600.00 = 60,000 cents)
      const soRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': ownerCookie
        },
        body: JSON.stringify({
          contact_id: customerId,
          type: 'SALE',
          due_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
          notes: 'Customer wholesale purchase order',
          lines: [{
            product_id: prodId,
            quantity: 10,
            pack_quantity: 2,
            unit_price_cents: 6000
          }]
        })
      });
      assert.equal(soRes.status, 201);
      const soData = await soRes.json();
      soId = soData.id;
      assert.equal(soData.status, 'DRAFT');

      // Approve/Confirm Sales Order -> reserves stock
      const confirmRes = await fetch(`${baseUrl}/api/orders/${soId}/confirm`, {
        method: 'POST',
        headers: { 'Cookie': ownerCookie }
      });
      assert.equal(confirmRes.status, 200);
      const confirmedSo = await confirmRes.json();
      assert.equal(confirmedSo.status, 'CONFIRMED');

      // Verify stock position: on_hand = 100, reserved = 10, available = 90
      const posRes = await fetch(`${baseUrl}/api/inventory/positions/${prodId}`, {
        headers: { 'Cookie': ownerCookie }
      });
      const pos = await posRes.json();
      assert.equal(pos.on_hand, 100, 'On-hand remains 100 until physically picked and shipped');
      assert.equal(pos.reserved, 10, 'Reserved stock must be 10 units');
      assert.equal(pos.available, 90, 'Available stock must be 90 units (100 on hand - 10 reserved)');
    });

    // =========================================================================
    // STEP 5: Ship 10 units
    // =========================================================================
    await t.test('Step 5: Ship 10 units -> on_hand = 90, reserved = 0, available = 90', async () => {
      // Fulfill / Ship the Sales Order
      const shipRes = await fetch(`${baseUrl}/api/orders/${soId}/fulfill`, {
        method: 'POST',
        headers: { 'Cookie': ownerCookie }
      });
      assert.equal(shipRes.status, 200);
      const fulfilledSo = await shipRes.json();
      assert.equal(fulfilledSo.status, 'FULFILLED');

      // Verify stock position: on_hand = 90, reserved = 0, available = 90
      const posRes = await fetch(`${baseUrl}/api/inventory/positions/${prodId}`, {
        headers: { 'Cookie': ownerCookie }
      });
      const pos = await posRes.json();
      assert.equal(pos.on_hand, 90, 'Physical on_hand must now be 90 units');
      assert.equal(pos.reserved, 0, 'Reservation is cleared upon shipment');
      assert.equal(pos.available, 90, 'Available stock must be 90 units');

      // Verify shipment ledger movement
      const movRes = await fetch(`${baseUrl}/api/inventory/movements?product_id=${prodId}`, {
        headers: { 'Cookie': ownerCookie }
      });
      const movements = await movRes.json();
      const latestMov = movements[0];
      assert.equal(latestMov.change_qty, -10);
      assert.equal(latestMov.balance_after, 90);
      assert.equal(latestMov.reason, 'SALE_FULFILLMENT');
    });

    // =========================================================================
    // STEP 6: Issue invoice & record partial payment
    // =========================================================================
    await t.test('Step 6: Invoice $600 & record partial payment of $250 -> verify AR ($350) and Cash ($50,250)', async () => {
      // Verify initial Accounts Receivable before payment: $600 (60,000 cents)
      const finRes1 = await fetch(`${baseUrl}/api/payments/summary`, {
        headers: { 'Cookie': ownerCookie }
      });
      const fin1 = await finRes1.json();
      assert.equal(fin1.accountsReceivable.totalCents, 60000, 'Total AR should reflect full $600 invoice');

      // Record partial customer payment of $250.00 (25,000 cents)
      const payRes = await fetch(`${baseUrl}/api/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': ownerCookie
        },
        body: JSON.stringify({
          order_id: soId,
          amount_cents: 25000,
          payment_method: 'BANK_TRANSFER',
          notes: 'Customer initial invoice deposit'
        })
      });
      assert.equal(payRes.status, 201);
      const payData = await payRes.json();
      assert.equal(payData.allocatedAmountCents, 25000);
      assert.equal(payData.newPaidCents, 25000);
      assert.equal(payData.remainingBalanceCents, 35000, 'Remaining balance must be $350 (35,000 cents)');
      assert.equal(payData.isFullyPaid, false);

      // Verify Accounts Receivable and Operating Cash updated dynamically
      const finRes2 = await fetch(`${baseUrl}/api/payments/summary`, {
        headers: { 'Cookie': ownerCookie }
      });
      const fin2 = await finRes2.json();
      assert.equal(fin2.accountsReceivable.totalCents, 35000, 'AR must decrease to $350.00');
      assert.equal(
        fin2.operatingCashCents,
        5025000,
        'Operating cash in bank must increase from $50,000.00 to $50,250.00'
      );
    });

    // =========================================================================
    // STEP 7: Supplier payment, customer return, cancellation, & blind count approval governance
    // =========================================================================
    await t.test('Step 7: Supplier payment, customer return, cancellation, and blind cycle count governance', async () => {
      // 1. Supplier payment: Pay the $2,500.00 PO bill in full
      const supPayRes = await fetch(`${baseUrl}/api/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': ownerCookie
        },
        body: JSON.stringify({
          order_id: poId,
          amount_cents: 250000,
          payment_method: 'ACH',
          notes: 'Vendor invoice settlement'
        })
      });
      assert.equal(supPayRes.status, 201);
      const supPayData = await supPayRes.json();
      assert.equal(supPayData.isFullyPaid, true);
      assert.equal(supPayData.remainingBalanceCents, 0);

      // Check cash outflow: $50,250 - $2,500 = $47,750 (4,775,000 cents)
      const finAfterBill = await (await fetch(`${baseUrl}/api/payments/summary`, { headers: { 'Cookie': ownerCookie } })).json();
      assert.equal(finAfterBill.operatingCashCents, 4775000);
      assert.equal(finAfterBill.accountsPayable.totalCents, 0, 'AP must be 0 after full settlement');

      // 2. Customer return: Customer returns 2 units
      const retOrderRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': ownerCookie
        },
        body: JSON.stringify({
          contact_id: customerId,
          type: 'RETURN',
          due_date: new Date().toISOString().split('T')[0],
          notes: 'Customer RMA return 2 units',
          lines: [{
            product_id: prodId,
            quantity: 2,
            unit_price_cents: 6000
          }]
        })
      });
      assert.equal(retOrderRes.status, 201);
      const retOrder = await retOrderRes.json();

      // Fulfill return order -> receives items back into on_hand inventory
      const retFulfillRes = await fetch(`${baseUrl}/api/orders/${retOrder.id}/fulfill`, {
        method: 'POST',
        headers: { 'Cookie': ownerCookie }
      });
      assert.equal(retFulfillRes.status, 200);

      const posAfterReturn = await (await fetch(`${baseUrl}/api/inventory/positions/${prodId}`, { headers: { 'Cookie': ownerCookie } })).json();
      assert.equal(posAfterReturn.on_hand, 92, 'Stock on-hand should increase from 90 to 92 after customer return');

      // 3. Order cancellation:
      // A. Create & confirm a draft sales order for 5 units
      const cancelTestOrderRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': ownerCookie },
        body: JSON.stringify({
          contact_id: customerId,
          type: 'SALE',
          due_date: new Date().toISOString().split('T')[0],
          lines: [{ product_id: prodId, quantity: 5 }]
        })
      });
      const cancelOrder = await cancelTestOrderRes.json();
      await fetch(`${baseUrl}/api/orders/${cancelOrder.id}/confirm`, { method: 'POST', headers: { 'Cookie': ownerCookie } });

      // Check reservation: reserved = 5, available = 87
      let posResCheck = await (await fetch(`${baseUrl}/api/inventory/positions/${prodId}`, { headers: { 'Cookie': ownerCookie } })).json();
      assert.equal(posResCheck.reserved, 5);
      assert.equal(posResCheck.available, 87);

      // Cancel the order -> reservation must be safely released
      const cancelRes = await fetch(`${baseUrl}/api/orders/${cancelOrder.id}/cancel`, {
        method: 'POST',
        headers: { 'Cookie': ownerCookie }
      });
      assert.equal(cancelRes.status, 200);
      const cancelledData = await cancelRes.json();
      assert.equal(cancelledData.status, 'CANCELLED');

      posResCheck = await (await fetch(`${baseUrl}/api/inventory/positions/${prodId}`, { headers: { 'Cookie': ownerCookie } })).json();
      assert.equal(posResCheck.reserved, 0, 'Cancelled order must release reservation');
      assert.equal(posResCheck.available, 92, 'Available stock restored to 92');

      // B. Attempting to cancel an already FULFILLED order must be rejected
      const badCancelRes = await fetch(`${baseUrl}/api/orders/${soId}/cancel`, {
        method: 'POST',
        headers: { 'Cookie': ownerCookie }
      });
      assert.equal(badCancelRes.status, 400, 'Cannot cancel already fulfilled order');

      // 4. Blind Stock Count Discrepancy Exceeding Approval Limit ($500)
      // Initiate blind cycle count
      const ccCreateRes = await fetch(`${baseUrl}/api/inventory/cycle-counts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': ownerCookie },
        body: JSON.stringify({
          location_id: locId,
          count_number: 'CC-E2E-AUDIT-01',
          is_blind_count: true
        })
      });
      assert.equal(ccCreateRes.status, 201);
      const cc = await ccCreateRes.json();
      ccId = cc.id;
      assert.ok(cc.is_blind_count);

      // Warehouse counts physical inventory: found 60 units (expected is 92, variance of -32 units)
      // Discrepancy value: 32 units * $25.00 cost = $800.00 (80,000 cents), which exceeds the $500 threshold
      const recordRes = await fetch(`${baseUrl}/api/inventory/cycle-counts/${ccId}/counts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': warehouseCookie },
        body: JSON.stringify({
          counts: [{
            product_id: prodId,
            counted_qty: 60,
            reason_code: 'UNEXPLAINED_DIFFERENCE',
            notes: 'Physical shelf count verified twice'
          }]
        })
      });
      assert.equal(recordRes.status, 200);

      // Submit for review
      await fetch(`${baseUrl}/api/inventory/cycle-counts/${ccId}/submit`, {
        method: 'POST',
        headers: { 'Cookie': warehouseCookie }
      });

      // Warehouse role attempts to approve -> MUST BE REJECTED (403 Forbidden due to $800 > $500 threshold)
      const whApproveRes = await fetch(`${baseUrl}/api/inventory/cycle-counts/${ccId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': warehouseCookie },
        body: JSON.stringify({ reviewer_notes: 'Warehouse tech attempting to write off $800' })
      });
      assert.equal(whApproveRes.status, 403, 'Warehouse staff must not be permitted to approve variance > threshold');
      const whErr = await whApproveRes.json();
      assert.equal(whErr.code, 'APPROVAL_THRESHOLD_EXCEEDED');

      // Owner approves reconciliation
      const ownerApproveRes = await fetch(`${baseUrl}/api/inventory/cycle-counts/${ccId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': ownerCookie },
        body: JSON.stringify({ reviewer_notes: 'Owner authorization after physical warehouse audit' })
      });
      assert.equal(ownerApproveRes.status, 200);
      const approvedCc = await ownerApproveRes.json();
      assert.equal(approvedCc.status, 'APPROVED');

      // Verify stock position adjusted to 60 units
      const posFinal = await (await fetch(`${baseUrl}/api/inventory/positions/${prodId}`, { headers: { 'Cookie': ownerCookie } })).json();
      assert.equal(posFinal.on_hand, 60, 'Physical inventory must reconcile to counted 60 units');
      assert.equal(posFinal.available, 60);

      // Verify adjustment entry recorded in immutable audit ledger
      const movAdjust = await (await fetch(`${baseUrl}/api/inventory/movements?product_id=${prodId}`, { headers: { 'Cookie': ownerCookie } })).json();
      const adjustMov = movAdjust[0];
      assert.equal(adjustMov.change_qty, -32, 'Discrepancy write-off of -32 units must be recorded');
      assert.equal(adjustMov.balance_after, 60);
      assert.ok(adjustMov.reason.includes('CYCLE_COUNT_ADJUSTMENT'));
    });

    // =========================================================================
    // STEP 8: Role bypass rejection, cross-business isolation, CSV duplicate guard,
    //         pack-size rounding, and persistence across server restart
    // =========================================================================
    await t.test('Step 8: Governance guards, cross-tenant isolation, duplicate CSV block, and persistence', async () => {
      // 1. Role Permission Bypass Rejection:
      // Warehouse user attempts to change business settings (e.g. increase approval threshold)
      const badSettingsRes = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Cookie': warehouseCookie },
        body: JSON.stringify({ approval_threshold_cents: 9999999 })
      });
      assert.equal(badSettingsRes.status, 403, 'Non-owner must be forbidden from updating business settings');

      // 2. Cross-Business Isolation:
      // Register a completely separate second business tenant
      const regRes = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'isolated_tenant_b@competitor.test',
          password: 'Password123!',
          businessName: 'Competitor Corp'
        })
      });
      assert.equal(regRes.status, 200);
      const tenantBCookie = regRes.headers.get('set-cookie').split(';')[0];

      // Query inventory positions with Tenant B: Must see 0 products (cannot see Business A's TEST-E2E-01)
      const tenantBProds = await (await fetch(`${baseUrl}/api/inventory/positions`, { headers: { 'Cookie': tenantBCookie } })).json();
      assert.equal(tenantBProds.length, 0, 'New tenant must start with 0 products and not leak other tenant data');

      // Query Business A's order by ID with Tenant B: Must return 404
      const tenantBOrder = await fetch(`${baseUrl}/api/orders/${soId}`, { headers: { 'Cookie': tenantBCookie } });
      assert.equal(tenantBOrder.status, 404, 'Tenant B cannot view Tenant A orders');

      // 3. Duplicate CSV Import Rejection:
      const importService = new ImportService(db);
      const csvData = `sku,barcode,name,category,base_unit,pack_size,lead_days,min_safety_stock,cost_price_cents,sell_price_cents
CSV-GUARD-01,777111,Precision Drill Head,Tools,pcs,5,10,15,4000,9000`;

      // First import succeeds
      const imp1 = importService.importProducts({ businessId: bizId, csvText: csvData });
      assert.equal(imp1.success, true);
      assert.equal(imp1.importedCount, 1);

      // Re-importing identical CSV must throw DUPLICATE_IMPORT_RECORD and roll back
      assert.throws(
        () => {
          importService.importProducts({ businessId: bizId, csvText: csvData });
        },
        (err) => {
          assert.equal(err.code, 'DUPLICATE_IMPORT_RECORD');
          return true;
        },
        'Re-importing identical CSV records must abort and roll back'
      );

      // 4. Pack-Size Rounding Verification:
      // Test product with pack_size = 6
      const pPack = db.prepare(`
        INSERT INTO products (business_id, sku, barcode, name, pack_size, lead_days, min_safety_stock, min_order_qty, cost_price_cents, sell_price_cents)
        VALUES (?, 'PACK-ROUND-01', 'BAR-PACK-01', 'Multi-Pack Filter Units', 6, 14, 20, 6, 1000, 2500)
      `).run(bizId);
      const pPackId = pPack.lastInsertRowid;

      const engine = new ReorderEngine(db);
      const recResult = engine.computeRecommendations(bizId);
      const packRec = recResult.recommendations.find((r) => r.productId === pPackId);
      if (packRec) {
        assert.equal(packRec.recommendedQty % 6, 0, 'Recommended quantity must be a strict multiple of pack_size (6)');
        assert.ok(packRec.recommendedQty >= 6, 'Recommended quantity must meet or exceed MOQ');
      }

      // 5. Persistence Across Server Restart:
      // Gracefully close active HTTP server and database connection
      server.close();
      db.close();

      // Reopen connection from the persistent disk file
      const reopenedDb = new DatabaseConnection(TEST_DB);
      const invServiceReopened = new InventoryService(reopenedDb);

      // Verify product TEST-E2E-01 on_hand is still 60
      const posPersisted = invServiceReopened.getStockPositions(bizId, prodId);
      assert.equal(posPersisted.on_hand, 60, 'Stock count 60 must persist across restart');

      // Verify business cash balance is still 4,775,000 cents
      const bizPersisted = reopenedDb.prepare('SELECT operating_cash_cents FROM businesses WHERE id = ?').get(bizId);
      assert.equal(bizPersisted.operating_cash_cents, 4775000, 'Operating cash must persist across restart');

      // Verify cycle count CC-E2E-AUDIT-01 is still APPROVED
      const ccPersisted = reopenedDb.prepare('SELECT status FROM cycle_counts WHERE id = ?').get(ccId);
      assert.equal(ccPersisted.status, 'APPROVED', 'Cycle count APPROVED status must persist across restart');

      reopenedDb.close();
    });

  } finally {
    try { server.close(); } catch (e) {}
    try { db.close(); } catch (e) {}
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }
});
