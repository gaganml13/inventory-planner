/**
 * benchmark_seeder.js — Native Benchmark Test Data Provisioner
 *
 * Implements the exact same logic as setup_test_dataset.py directly in Node.js
 * using the project's SQLite connection.
 */

'use strict';

function seedBenchmarkData(db, businessId = 1) {
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  // 1. Ensure Business exists
  const biz = db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
  if (!biz) {
    db.prepare(`
      INSERT INTO businesses (id, name, currency, cash_reserve_cents, operating_cash_cents, slug, is_demo)
      VALUES (?, 'Vanguard Wholesale Corp', 'USD', 5000000, 18500000, 'demo-vanguard-wholesale', 1)
    `).run(businessId);
  }

  // 2. Ensure Location exists
  let locationId;
  const loc = db.prepare('SELECT id FROM locations WHERE business_id = ? LIMIT 1').get(businessId);
  if (loc) {
    locationId = loc.id;
  } else {
    const locRes = db.prepare(`
      INSERT INTO locations (business_id, name, description)
      VALUES (?, 'Primary Distribution Depot', 'Benchmark logistics facility')
    `).run(businessId);
    locationId = locRes.lastInsertRowid;
  }

  // 3. Ensure Customer Contact exists (Resolves orders.contact_id NOT NULL)
  let customerId;
  const cust = db.prepare("SELECT id FROM contacts WHERE type = 'CUSTOMER' AND business_id = ? LIMIT 1").get(businessId);
  if (cust) {
    customerId = cust.id;
  } else {
    const custRes = db.prepare(`
      INSERT INTO contacts (business_id, type, name, email, phone, credit_limit_cents, payment_terms_days)
      VALUES (?, 'CUSTOMER', 'Wholesale Retailer Alpha', 'orders@alpha.example.com', '+1-555-0100', 5000000, 30)
    `).run(businessId);
    customerId = custRes.lastInsertRowid;
  }

  // 4. Ensure Supplier Contact exists
  let supplierId;
  const sup = db.prepare("SELECT id FROM contacts WHERE type = 'SUPPLIER' AND business_id = ? LIMIT 1").get(businessId);
  if (sup) {
    supplierId = sup.id;
  } else {
    const supRes = db.prepare(`
      INSERT INTO contacts (business_id, type, name, email, phone, credit_limit_cents, payment_terms_days)
      VALUES (?, 'SUPPLIER', 'Global Component Supply', 'supply@globalcomponent.example.com', '+1-555-0199', 0, 30)
    `).run(businessId);
    supplierId = supRes.lastInsertRowid;
  }

  // 5. Define 3 Benchmark Products
  const benchmarks = [
    {
      sku: 'TEST-FAST-01',
      barcode: '999000100001',
      name: 'Ultra-Speed Fast Mover Cable 1m',
      category: 'Electronics',
      base_unit: 'pcs',
      pack_size: 10,
      lead_days: 5,
      min_safety_stock: 50,
      cost_price_cents: 400,
      sell_price_cents: 950,
      initial_stock: 2500,
      pattern: 'high_velocity'
    },
    {
      sku: 'TEST-STEADY-02',
      barcode: '999000100002',
      name: 'Standard Ergonomic Desktop Stand',
      category: 'Hardware',
      base_unit: 'pcs',
      pack_size: 4,
      lead_days: 7,
      min_safety_stock: 20,
      cost_price_cents: 1500,
      sell_price_cents: 3200,
      initial_stock: 800,
      pattern: 'weekday_steady'
    },
    {
      sku: 'TEST-LUMPY-03',
      barcode: '999000100003',
      name: 'Industrial High-Capacity Server Rack',
      category: 'Infrastructure',
      base_unit: 'pcs',
      pack_size: 1,
      lead_days: 14,
      min_safety_stock: 5,
      cost_price_cents: 45000,
      sell_price_cents: 85000,
      initial_stock: 120,
      pattern: 'sporadic_bursts'
    }
  ];

  const productMap = {};

  const tx = db.transaction(() => {
    for (const b of benchmarks) {
      const existing = db.prepare('SELECT id FROM products WHERE business_id = ? AND sku = ?').get(businessId, b.sku);
      let prodId;
      if (existing) {
        prodId = existing.id;
        db.prepare(`
          UPDATE products SET
            barcode = ?, name = ?, category = ?, pack_size = ?,
            lead_days = ?, min_safety_stock = ?, cost_price_cents = ?,
            sell_price_cents = ?
          WHERE id = ?
        `).run(b.barcode, b.name, b.category, b.pack_size, b.lead_days, b.min_safety_stock, b.cost_price_cents, b.sell_price_cents, prodId);
      } else {
        const res = db.prepare(`
          INSERT INTO products (
            business_id, sku, barcode, name, category, base_unit,
            pack_size, lead_days, min_safety_stock, cost_price_cents,
            sell_price_cents, source_tag
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BENCHMARK')
        `).run(businessId, b.sku, b.barcode, b.name, b.category, b.base_unit, b.pack_size, b.lead_days, b.min_safety_stock, b.cost_price_cents, b.sell_price_cents);
        prodId = res.lastInsertRowid;
      }
      productMap[b.sku] = { ...b, id: prodId };
    }

    // Clean up prior benchmark orders and stock movements
    db.prepare("DELETE FROM orders WHERE business_id = ? AND order_number LIKE 'BM-SO-%'").run(businessId);

    for (const b of benchmarks) {
      db.prepare("DELETE FROM stock_movements WHERE business_id = ? AND product_id = ? AND (source_tag = 'BENCHMARK' OR reason LIKE 'BENCHMARK_%')")
        .run(businessId, productMap[b.sku].id);
    }

    // Provision Initial Stock Movements 46 days ago
    const initialTime = new Date(now.getTime() - 46 * dayMs).toISOString();
    const currentBalances = {};
    for (const b of benchmarks) {
      const pid = productMap[b.sku].id;
      const qty = b.initial_stock;
      currentBalances[pid] = qty;
      db.prepare(`
        INSERT INTO stock_movements (
          business_id, product_id, location_id, change_qty,
          balance_after, reason, order_line_id, source_tag, created_at
        ) VALUES (?, ?, ?, ?, ?, 'BENCHMARK_INITIAL_COUNT', NULL, 'BENCHMARK', ?)
      `).run(businessId, pid, locationId, qty, qty, initialTime);
    }

    // Generate 45 Days of Realistic Daily Sales Order History
    const burstOffsets = new Set([40, 31, 22, 13, 4]);

    for (let dayOffset = 45; dayOffset >= 1; dayOffset--) {
      const orderDateDt = new Date(now.getTime() - dayOffset * dayMs);
      const orderDateStr = orderDateDt.toISOString().split('T')[0];
      const orderIso = orderDateDt.toISOString();
      const dueIso = new Date(orderDateDt.getTime() + 15 * dayMs).toISOString();
      const dow = orderDateDt.getUTCDay();

      const dailyItems = [];

      // 1. TEST-FAST-01: High velocity (25 - 60 units/day)
      const fastBase = 40.0;
      const dowMultiplier = (dow >= 2 && dow <= 5) ? 1.3 : (dow === 1 ? 1.0 : 0.7);
      const trend = 1.0 + (45 - dayOffset) * 0.004;
      let fastQty = Math.round(fastBase * dowMultiplier * trend + (dayOffset % 7 - 3));
      fastQty = Math.max(20, Math.min(65, fastQty));
      dailyItems.push({ sku: 'TEST-FAST-01', qty: fastQty });

      // 2. TEST-STEADY-02: Weekday steady (8 - 14 units Mon-Fri, 0 - 2 units Sat-Sun)
      if (dow >= 1 && dow <= 5) {
        dailyItems.push({ sku: 'TEST-STEADY-02', qty: 8 + (dayOffset % 7) });
      } else {
        const weekendQty = dayOffset % 2 === 0 ? 1 : 0;
        if (weekendQty > 0) dailyItems.push({ sku: 'TEST-STEADY-02', qty: weekendQty });
      }

      // 3. TEST-LUMPY-03: Sporadic bursts
      if (burstOffsets.has(dayOffset)) {
        dailyItems.push({ sku: 'TEST-LUMPY-03', qty: 12 + (dayOffset % 9) });
      }

      if (dailyItems.length === 0) continue;

      const orderNum = `BM-SO-${businessId}-${dayOffset}`;
      let orderTotalCents = 0;

      for (const item of dailyItems) {
        const pInfo = productMap[item.sku];
        orderTotalCents += item.qty * pInfo.sell_price_cents;
      }

      const orderRes = db.prepare(`
        INSERT INTO orders (
          business_id, contact_id, order_number, type, status,
          order_date, due_date, total_cents, paid_cents, notes,
          allow_backorder, source_tag, created_at
        ) VALUES (?, ?, ?, 'SALE', 'FULFILLED', ?, ?, ?, ?, 'Benchmark historical sales fulfillment', 0, 'BENCHMARK', ?)
      `).run(businessId, customerId, orderNum, orderDateStr, dueIso, orderTotalCents, orderTotalCents, orderIso);

      const orderId = orderRes.lastInsertRowid;

      for (const item of dailyItems) {
        const pInfo = productMap[item.sku];
        const pid = pInfo.id;
        const packQty = Math.max(1, Math.ceil(item.qty / pInfo.pack_size));
        const lineTotal = item.qty * pInfo.sell_price_cents;

        const lineRes = db.prepare(`
          INSERT INTO order_lines (
            order_id, product_id, quantity, pack_quantity,
            unit_price_cents, tax_cents, discount_cents, total_cents
          ) VALUES (?, ?, ?, ?, ?, 0, 0, ?)
        `).run(orderId, pid, item.qty, packQty, pInfo.sell_price_cents, lineTotal);

        const lineId = lineRes.lastInsertRowid;
        const newBal = currentBalances[pid] - item.qty;
        currentBalances[pid] = newBal;

        db.prepare(`
          INSERT INTO stock_movements (
            business_id, product_id, location_id, change_qty,
            balance_after, reason, order_line_id, source_tag, created_at
          ) VALUES (?, ?, ?, ?, ?, 'BENCHMARK_SALE_FULFILLMENT', ?, 'BENCHMARK', ?)
        `).run(businessId, pid, locationId, -item.qty, newBal, lineId, orderIso);
      }
    }

    return currentBalances;
  });

  const finalBalances = tx();

  return {
    success: true,
    business_id: businessId,
    benchmark_products: benchmarks.map((b) => ({
      sku: b.sku,
      name: b.name,
      pattern: b.pattern,
      productId: productMap[b.sku].id,
      closingStock: finalBalances[productMap[b.sku].id]
    })),
    days_generated: 45,
    customerId,
    supplierId,
    locationId,
    status: 'COMPLETED'
  };
}

module.exports = { seedBenchmarkData };
