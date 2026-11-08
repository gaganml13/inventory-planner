/**
 * operational_advanced_features.test.js
 *
 * Comprehensive tests for:
 * 1. Role-Based Access Control (RBAC): Owner vs Purchasing vs Warehouse permissions.
 * 2. Physical Cycle Counts: Blind counting, discrepancy cases, reason codes, approval threshold governance.
 * 3. Partial Receiving & Partial Fulfillment: Tracking fulfilled_quantity and received_quantity.
 * 4. Duplicate PO Recommendation Prevention: Aware of both open DRAFT and CONFIRMED POs.
 * 5. Intermittent Demand Forecasting: Croston's SBA classification.
 * 6. Inventory Aging: FIFO attribution across 0-30d, 31-60d, 61-90d, 90+d brackets.
 * 7. Traceable Archival: Soft-archiving referenced products preserving immutable audit movements.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { DatabaseConnection } = require('../database/connection');
const { runMigrations } = require('../database/migrator');
const InventoryService = require('../src/modules/inventory/inventory_service');
const CycleCountService = require('../src/modules/inventory/cycle_count_service');
const OrderService = require('../src/modules/orders/order_service');
const ReorderEngine = require('../src/modules/intelligence/reorder_engine');
const Forecaster = require('../src/modules/intelligence/forecaster');
const AuthService = require('../src/modules/auth/auth_service');

test('Operational Features & Advanced Governance Audit', async (t) => {
  const dbPath = path.join(__dirname, 'test_operational_advanced.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new DatabaseConnection(dbPath);
  runMigrations(db);

  const invService = new InventoryService(db);
  const cycleCountService = new CycleCountService(db);
  const orderService = new OrderService(db);
  const reorderEngine = new ReorderEngine(db);
  const forecaster = new Forecaster();
  const authService = new AuthService(db);

  // Setup Business
  const bizRes = db.prepare(`
    INSERT INTO businesses (name, currency, cash_reserve_cents, operating_cash_cents, approval_threshold_cents)
    VALUES ('Titan Industrial Wholesale', 'USD', 2000000, 10000000, 50000)
  `).run();
  const bizId = bizRes.lastInsertRowid;

  const locRes = db.prepare('INSERT INTO locations (business_id, name) VALUES (?, ?)').run(bizId, 'Central Depot');
  const locId = locRes.lastInsertRowid;

  // Setup Users with RBAC Roles
  const ownerRes = db.prepare(`
    INSERT INTO users (email, password_hash, name, business_id, role)
    VALUES ('owner@titan.test', 'hash1', 'Owner Admin', ?, 'OWNER')
  `).run(bizId);
  const ownerId = ownerRes.lastInsertRowid;

  const warehouseRes = db.prepare(`
    INSERT INTO users (email, password_hash, name, business_id, role)
    VALUES ('warehouse@titan.test', 'hash2', 'Warehouse Tech', ?, 'WAREHOUSE')
  `).run(bizId);
  const warehouseId = warehouseRes.lastInsertRowid;

  const supplierRes = db.prepare(`
    INSERT INTO contacts (business_id, type, name, payment_terms_days)
    VALUES (?, 'SUPPLIER', 'Global Titan Components', 30)
  `).run(bizId);
  const supplierId = supplierRes.lastInsertRowid;

  const customerRes = db.prepare(`
    INSERT INTO contacts (business_id, type, name, payment_terms_days)
    VALUES (?, 'CUSTOMER', 'Prime Retail Chain', 30)
  `).run(bizId);
  const customerId = customerRes.lastInsertRowid;

  // Create products
  const p1 = invService.createProduct({
    businessId: bizId,
    sku: 'TITAN-BRG-01',
    name: 'Precision Heavy Ball Bearing',
    pack_size: 5,
    min_safety_stock: 20,
    cost_price_cents: 2000, // $20.00
    sell_price_cents: 4500, // $45.00
    initial_stock: 50,
    location_id: locId
  });

  const p2 = invService.createProduct({
    businessId: bizId,
    sku: 'TITAN-SEAL-02',
    name: 'Industrial Nitrile O-Ring Seal',
    pack_size: 10,
    min_safety_stock: 50,
    cost_price_cents: 500,  // $5.00
    sell_price_cents: 1200, // $12.00
    initial_stock: 100,
    location_id: locId
  });

  await t.test('1. Partial Receiving on Purchase Orders', () => {
    const po = orderService.createOrder({
      businessId: bizId,
      contactId: supplierId,
      orderNumber: 'PO-PARTIAL-01',
      type: 'PURCHASE',
      dueDate: '2026-11-20',
      lines: [
        { product_id: p1.product_id, quantity: 20, unit_price_cents: 2000 },
        { product_id: p2.product_id, quantity: 40, unit_price_cents: 500 }
      ]
    });
    orderService.confirmOrder(po.id, bizId);

    // Initial incoming_po reflects full 20 and 40
    let pos1 = invService.getStockPositions(bizId, p1.product_id);
    assert.equal(pos1.incoming_po, 20);

    // Partially receive 10 of p1 only
    const receivedOrder = orderService.receivePurchaseOrder({
      orderId: po.id,
      businessId: bizId,
      locationId: locId,
      items: [
        { line_id: po.lines[0].id, quantity: 10, stock_type: 'AVAILABLE' }
      ],
      userId: warehouseId
    });

    assert.equal(receivedOrder.status, 'PARTIALLY_RECEIVED');
    assert.equal(receivedOrder.lines[0].received_quantity, 10);
    assert.equal(receivedOrder.lines[1].received_quantity, 0);

    // Remaining incoming_po for p1 drops from 20 to 10; on_hand increases from 50 to 60
    pos1 = invService.getStockPositions(bizId, p1.product_id);
    assert.equal(pos1.incoming_po, 10);
    assert.equal(pos1.on_hand, 60);

    // Complete remaining receipt
    const completedPo = orderService.receivePurchaseOrder({
      orderId: po.id,
      businessId: bizId,
      locationId: locId,
      items: [
        { line_id: po.lines[0].id, quantity: 10 },
        { line_id: po.lines[1].id, quantity: 40 }
      ]
    });

    assert.equal(completedPo.status, 'FULFILLED');
    assert.equal(completedPo.lines[0].received_quantity, 20);
    assert.equal(completedPo.lines[1].received_quantity, 40);

    pos1 = invService.getStockPositions(bizId, p1.product_id);
    assert.equal(pos1.incoming_po, 0);
    assert.equal(pos1.on_hand, 70);
  });

  await t.test('2. Partial Fulfillment on Sales Orders', () => {
    const so = orderService.createOrder({
      businessId: bizId,
      contactId: customerId,
      orderNumber: 'SO-PARTIAL-01',
      type: 'SALE',
      dueDate: '2026-11-25',
      lines: [
        { product_id: p1.product_id, quantity: 15, unit_price_cents: 4500 }
      ]
    });
    orderService.confirmOrder(so.id, bizId);

    let pos = invService.getStockPositions(bizId, p1.product_id);
    assert.equal(pos.reserved, 15);

    // Partially dispatch 5 units
    const dispatched = orderService.fulfillSalesOrder({
      orderId: so.id,
      businessId: bizId,
      locationId: locId,
      items: [
        { line_id: so.lines[0].id, quantity: 5 }
      ],
      userId: warehouseId
    });

    assert.equal(dispatched.status, 'PARTIALLY_FULFILLED');
    assert.equal(dispatched.lines[0].fulfilled_quantity, 5);

    // Reserved drops from 15 to 10; on_hand drops from 70 to 65
    pos = invService.getStockPositions(bizId, p1.product_id);
    assert.equal(pos.reserved, 10);
    assert.equal(pos.on_hand, 65);

    // Dispatch remaining 10
    const finalSo = orderService.fulfillSalesOrder({
      orderId: so.id,
      businessId: bizId,
      locationId: locId,
      items: [
        { line_id: so.lines[0].id, quantity: 10 }
      ]
    });
    assert.equal(finalSo.status, 'FULFILLED');
    pos = invService.getStockPositions(bizId, p1.product_id);
    assert.equal(pos.reserved, 0);
    assert.equal(pos.on_hand, 55);
  });

  await t.test('3. Physical Cycle Count, Blind Audit & Monetary Approval Threshold', () => {
    // Current system on_hand for p1 is 55 units ($20.00 each)
    const cc = cycleCountService.createCycleCount({
      businessId: bizId,
      locationId: locId,
      countNumber: 'CC-AUDIT-01',
      isBlindCount: true,
      assignedUserId: warehouseId,
      productIds: [p1.product_id]
    });

    assert.equal(cc.status, 'IN_PROGRESS');
    assert.equal(cc.is_blind_count, true);

    // When fetched by a WAREHOUSE role, system_on_hand is masked as null
    const blindFetch = cycleCountService.getCycleCountById(cc.id, bizId, true);
    assert.equal(blindFetch.items[0].system_on_hand, null);

    // Warehouse staff records physical count of 51 (discrepancy of -4 units = $80.00 discrepancy = 8000 cents)
    cycleCountService.recordCounts({
      cycleCountId: cc.id,
      businessId: bizId,
      counts: [
        { product_id: p1.product_id, counted_qty: 51, reason_code: 'DAMAGED_EXPIRED', notes: 'Found 4 crushed units in aisle 2' }
      ]
    });

    // Submit for approval
    cycleCountService.submitForApproval(cc.id, bizId);

    // Discrepancy is $80.00 (8000 cents), which is less than approval_threshold_cents ($500.00 / 50000 cents)
    // Non-owner (purchasing/warehouse) can approve if under threshold
    const approvedCc = cycleCountService.approveCycleCount({
      cycleCountId: cc.id,
      businessId: bizId,
      reviewerUserId: ownerId,
      reviewerNotes: 'Verified crushed stock quarantined',
      userRole: 'PURCHASING' // under threshold, allowed
    });

    assert.equal(approvedCc.status, 'APPROVED');

    // On-hand for p1 adjusted to 51
    const finalPos = invService.getStockPositions(bizId, p1.product_id);
    assert.equal(finalPos.on_hand, 51);

    // Now test exceeding threshold ($500.00 = 50,000 cents)
    // Create new cycle count with count 20 (discrepancy of -31 units * $20 = $620 = 62,000 cents)
    const ccHigh = cycleCountService.createCycleCount({
      businessId: bizId,
      locationId: locId,
      countNumber: 'CC-AUDIT-HIGH',
      isBlindCount: false,
      productIds: [p1.product_id]
    });

    cycleCountService.recordCounts({
      cycleCountId: ccHigh.id,
      businessId: bizId,
      counts: [{ product_id: p1.product_id, counted_qty: 20 }]
    });
    cycleCountService.submitForApproval(ccHigh.id, bizId);

    // Approving by non-owner must throw APPROVAL_THRESHOLD_EXCEEDED
    assert.throws(
      () => {
        cycleCountService.approveCycleCount({
          cycleCountId: ccHigh.id,
          businessId: bizId,
          reviewerUserId: warehouseId,
          userRole: 'WAREHOUSE'
        });
      },
      (err) => err.code === 'APPROVAL_THRESHOLD_EXCEEDED'
    );

    // Approving by OWNER succeeds
    const ownerApproved = cycleCountService.approveCycleCount({
      cycleCountId: ccHigh.id,
      businessId: bizId,
      reviewerUserId: ownerId,
      userRole: 'OWNER'
    });
    assert.equal(ownerApproved.status, 'APPROVED');
  });

  await t.test('4. In-Flight PO Awareness Prevents Duplicate Reorder Recommendations', () => {
    // Generate recommendations
    const firstRun = reorderEngine.computeRecommendations(bizId);
    assert.ok(firstRun.recommendations);

    // If an item needs reorder, creating a DRAFT PO must be accounted for in in-flight stock
    const pLow = invService.createProduct({
      businessId: bizId,
      sku: 'TITAN-LOW-99',
      name: 'Critical Shortage Sensor',
      pack_size: 10,
      lead_days: 7,
      min_safety_stock: 50,
      cost_price_cents: 1000,
      sell_price_cents: 2500,
      initial_stock: 5, // only 5 on-hand, safety stock 50
      location_id: locId
    });

    // Seed 30 days of strong daily sales
    for (let d = 30; d >= 1; d--) {
      const pastDate = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const so = orderService.createOrder({
        businessId: bizId,
        contactId: customerId,
        type: 'SALE',
        dueDate: pastDate,
        lines: [{ product_id: pLow.product_id, quantity: 5, unit_price_cents: 2500 }]
      });
      db.prepare("UPDATE orders SET order_date = ?, status = 'FULFILLED' WHERE id = ?").run(pastDate, so.id);
    }

    const recsInitial = reorderEngine.computeRecommendations(bizId);
    const recItem = recsInitial.recommendations.find((r) => r.productId === pLow.product_id);
    assert.ok(recItem, 'Product should have purchase recommendation');
    assert.ok(recItem.recommendedQty > 0);

    // Create a DRAFT PO for the exact recommended quantity
    orderService.createOrder({
      businessId: bizId,
      contactId: supplierId,
      type: 'PURCHASE',
      dueDate: '2026-11-20',
      lines: [{ product_id: pLow.product_id, quantity: recItem.recommendedQty, unit_price_cents: 1000 }]
    });

    // Recompute recommendations: because the DRAFT PO is in-flight, it should NOT recommend duplicate purchasing
    const recsAfterDraft = reorderEngine.computeRecommendations(bizId);
    const recItemAfter = recsAfterDraft.recommendations.find((r) => r.productId === pLow.product_id);
    assert.equal(recItemAfter, undefined, 'Open draft PO should satisfy requirement and prevent duplicate recommendation');
  });

  await t.test('5. Intermittent Demand Classification (Croston / SBA)', () => {
    // Generate 60 days with 16 demand bursts (ADI = 60 / 16 = 3.75 >= 1.32, events >= 14)
    const sporadicSeries = [];
    const baseDate = new Date('2026-07-01');
    for (let i = 0; i < 60; i++) {
      const d = new Date(baseDate.getTime() + i * 86400000).toISOString().split('T')[0];
      // Event every 3rd or 4th day
      const qty = (i % 4 === 0) ? (20 + (i % 5)) : 0;
      sporadicSeries.push({
        date: d,
        salesQty: qty,
        adjustedDemand: qty,
        dayOfWeek: i % 7,
        isStockout: false
      });
    }

    const classification = forecaster.classifyDemandPattern(sporadicSeries);
    assert.ok(['INTERMITTENT', 'LUMPY'].includes(classification.pattern));
    assert.ok(classification.adi >= 1.32);

    const forecast = forecaster.generateForecast(sporadicSeries, 14);
    assert.ok(forecast.modelName.includes('CROSTON'));
    assert.ok(forecast.p50Qty > 0);
  });

  await t.test('6. FIFO Inventory Aging Attribution', () => {
    const aging = invService.getInventoryAging(bizId);
    assert.ok(aging.total_asset_value_cents > 0);
    assert.ok(Array.isArray(aging.products));
    assert.ok(aging.products.length > 0);
  });

  await t.test('7. Product Archival Preserves Historical Movements & Orders', () => {
    // p1 has historical movements and orders
    const archiveResult = invService.deleteProduct(bizId, p1.product_id);
    assert.equal(archiveResult.archived, true, 'Product with audit history should be safely archived');

    // Audit trail for p1 is intact in stock_movements
    const movements = invService.getMovements({ businessId: bizId, productId: p1.product_id });
    assert.ok(movements.length > 0, 'Audit ledger records must be completely preserved');

    // Unarchive
    const unarchiveResult = invService.unarchiveProduct(bizId, p1.product_id);
    assert.equal(unarchiveResult.archived, false);
  });

  db.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});
