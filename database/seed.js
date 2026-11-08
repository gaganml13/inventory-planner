/**
 * seed.js — Comprehensive Seed Generator for Smart Business Manager
 *
 * Populates realistic multi-entity data:
 * - Wholesale business with working capital and reserve configuration
 * - Storage locations and commercial contacts (Customers & Suppliers)
 * - Catalog items with pack sizes, lead times, costs, and prices
 * - Initial stock ledger records
 * - 60 days of historical sales orders & movements (including intentional stockout periods for censored demand)
 * - Open sales orders (reserved stock) and open purchase orders (incoming stock)
 * - Split payment allocations (demonstrating AR and AP)
 * - Source tags ('UCI_RETAIL' and 'SYNTHETIC') and data import hashes
 */

'use strict';

const crypto = require('crypto');
const { getDb } = require('./connection');
const { runMigrations } = require('./migrator');

function hashLine(str) {
  return crypto.createHash('sha256').update(str.trim()).digest('hex');
}

function seedDatabase(customDb) {
  const db = customDb || getDb();
  runMigrations(db);

  // Check if business already exists
  const existingBiz = db.prepare('SELECT id FROM businesses LIMIT 1').get();
  if (existingBiz) {
    db.prepare(`
      UPDATE businesses 
      SET slug = 'demo-vanguard-wholesale', is_demo = 1,
          name = CASE WHEN name LIKE '%Apex Wholesale%' THEN 'Vanguard Wholesale Distribution Corp' ELSE name END
      WHERE id = ? AND (slug IS NULL OR slug = '' OR is_demo = 0 OR slug = 'demo-apex-wholesale')
    `).run(existingBiz.id);

    const guestExists = db.prepare('SELECT id FROM users WHERE is_guest = 1 LIMIT 1').get();
    if (!guestExists) {
      db.prepare(`
        INSERT INTO users (email, password_hash, name, business_id, is_guest)
        VALUES (?, ?, ?, ?, ?)
      `).run('guest@vanguardwholesale.demo', 'guest_mode_hash', 'Guest Operator', existingBiz.id, 1);
    }
    return existingBiz.id;
  }

  let businessId;

  const seedTx = db.transaction(() => {
    // 1. Create wholesale business
    const bizRes = db.prepare(`
      INSERT INTO businesses (name, currency, cash_reserve_cents, operating_cash_cents, slug, is_demo)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('Vanguard Wholesale Distribution Corp', 'USD', 5000000, 18500000, 'demo-vanguard-wholesale', 1); // $50k reserve, $185k operating
    businessId = bizRes.lastInsertRowid;

    // Create guest demo user
    db.prepare(`
      INSERT INTO users (email, password_hash, name, business_id, is_guest)
      VALUES (?, ?, ?, ?, ?)
    `).run('guest@vanguardwholesale.demo', 'guest_mode_hash', 'Guest Operator', businessId, 1);

    // 2. Locations
    const locInsert = db.prepare(`
      INSERT INTO locations (business_id, name, description)
      VALUES (?, ?, ?)
    `);
    const locWh = locInsert.run(businessId, 'Main Distribution Center', 'Primary 20,000 sq ft logistics depot').lastInsertRowid;
    const locBulk = locInsert.run(businessId, 'Aisle Bay C-High Rack', 'Pallet storage for bulk carton packs').lastInsertRowid;
    const locPick = locInsert.run(businessId, 'Rapid Pick Front Station', 'Active order picking zone').lastInsertRowid;

    // 3. Contacts (Customers & Suppliers)
    const contactInsert = db.prepare(`
      INSERT INTO contacts (business_id, type, name, email, phone, credit_limit_cents, payment_terms_days)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Suppliers
    const supTech = contactInsert.run(businessId, 'SUPPLIER', 'Global Micro Tech Ltd', 'orders@globalmicro.example.com', '+1-555-0192', 0, 30).lastInsertRowid;
    const supFurn = contactInsert.run(businessId, 'SUPPLIER', 'Nordic Commercial Furniture', 'supply@nordicfurn.example.com', '+1-555-0193', 0, 45).lastInsertRowid;
    const supCons = contactInsert.run(businessId, 'SUPPLIER', 'Vanguard Office Supply Hub', 'trade@vanguardofficesupply.example.com', '+1-555-0194', 0, 15).lastInsertRowid;
    const supSafe = contactInsert.run(businessId, 'SUPPLIER', 'BioSafety Industrial Gear', 'sales@biosafetygear.example.com', '+1-555-0195', 0, 30).lastInsertRowid;

    // Customers
    const custMetro = contactInsert.run(businessId, 'CUSTOMER', 'Metro Retail Outlets Hub', 'procurement@metroretail.example.com', '+1-555-0201', 3500000, 30).lastInsertRowid; // $35k credit
    const custCoast = contactInsert.run(businessId, 'CUSTOMER', 'Coastal Hardware Stores', 'accounts@coastalhardware.example.com', '+1-555-0202', 5000000, 15).lastInsertRowid; // $50k credit
    const custCascade = contactInsert.run(businessId, 'CUSTOMER', 'Cascade Tech Systems Inc', 'orders@cascadetech.example.com', '+1-555-0203', 6000000, 30).lastInsertRowid; // $60k credit
    const custSummit = contactInsert.run(businessId, 'CUSTOMER', 'Summit Workplace Interiors', 'billing@summitinteriors.example.com', '+1-555-0204', 2000000, 7).lastInsertRowid;  // $20k credit

    // 4. Products Catalog
    const prodInsert = db.prepare(`
      INSERT INTO products (
        business_id, sku, barcode, name, category, base_unit, pack_size,
        lead_days, min_safety_stock, cost_price_cents, sell_price_cents, source_tag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const rawProducts = [
      ['ELEC-USB-C2M', '079943911221', 'USB-C Heavy Duty Braided Cable 2m', 'Electronics', 'pcs', 10, 7, 30, 350, 850, 'UCI_RETAIL'],
      ['ELEC-HDMI-4K',  '079943911222', 'HDMI 2.1 Ultra HD 8K Cable 2m',     'Electronics', 'pcs',  5, 7, 25, 550, 1400, 'UCI_RETAIL'],
      ['ELEC-WL-MOU',   '079943911223', 'Ergonomic Silent Wireless Mouse',    'Electronics', 'pcs',  4, 10, 20, 1200, 2600, 'UCI_RETAIL'],
      ['ELEC-MECH-KB',  '079943911224', 'Tactile Mechanical Pro Keyboard',    'Electronics', 'pcs',  2, 12, 15, 3400, 7500, 'UCI_RETAIL'],
      ['ELEC-HUB-7P',   '079943911225', 'Powered USB 3.2 7-Port Hub',        'Electronics', 'pcs',  4, 8, 20, 1800, 3900, 'UCI_RETAIL'],
      ['FURN-MESH-CHR', '079943911226', 'Ergonomic High-Back Mesh Chair',     'Furniture',   'pcs',  1, 14, 8, 8500, 18500, 'SYNTHETIC'],
      ['FURN-STND-DSK', '079943911227', 'Dual Motor Standing Desk Frame',     'Furniture',   'pcs',  1, 14, 6, 16000, 34000, 'SYNTHETIC'],
      ['FURN-MNTR-ARM', '079943911228', 'Gas Spring Dual Monitor Arm',        'Furniture',   'pcs',  2, 10, 10, 3200, 7200, 'SYNTHETIC'],
      ['CONS-COPY-A4',  '079943911229', 'A4 Bright White Paper (500s Ream)',  'Consumables', 'reams', 5, 5, 50, 320, 680, 'UCI_RETAIL'],
      ['CONS-GEL-PEN',  '079943911230', 'Rollerball Gel Pens Black 50pk',     'Consumables', 'boxes', 10, 5, 30, 950, 2200, 'UCI_RETAIL'],
      ['CONS-STICKY-N', '079943911231', 'Sticky Notes 3x3 Canary Pack 12',   'Consumables', 'packs', 10, 5, 40, 420, 980, 'UCI_RETAIL'],
      ['SAFE-HELM-PRO', '079943911232', 'Vented Hard Hat Safety Helmet',      'Safety',      'pcs',  4, 8, 25, 1100, 2500, 'SYNTHETIC'],
      ['SAFE-VEST-HIV', '079943911233', 'Class 2 High-Visibility Vest',       'Safety',      'pcs',  10, 7, 35, 450, 1100, 'SYNTHETIC']
    ];

    const productMap = {};

    for (const p of rawProducts) {
      const res = prodInsert.run(businessId, ...p);
      const prodId = res.lastInsertRowid;
      productMap[p[0]] = {
        id: prodId,
        sku: p[0],
        name: p[2],
        category: p[3],
        pack_size: p[5],
        lead_days: p[6],
        min_safety_stock: p[7],
        cost_price_cents: p[8],
        sell_price_cents: p[9],
        source_tag: p[10]
      };

      // Record import hash
      const lineStr = p.join(',');
      db.prepare(`
        INSERT OR IGNORE INTO data_import_hashes (business_id, import_type, line_hash, source_tag, record_metadata)
        VALUES (?, 'PRODUCTS', ?, ?, ?)
      `).run(businessId, hashLine(lineStr), p[10], p[0]);
    }

    // 5. Initial Inventory Baseline & Stock Movements (60 days ago)
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const initialQtys = {
      'ELEC-USB-C2M': 750,
      'ELEC-HDMI-4K': 500,
      'ELEC-WL-MOU': 350,
      'ELEC-MECH-KB': 200,
      'ELEC-HUB-7P': 300,
      'FURN-MESH-CHR': 100,
      'FURN-STND-DSK': 75,
      'FURN-MNTR-ARM': 120,
      'CONS-COPY-A4': 1000,
      'CONS-GEL-PEN': 500,
      'CONS-STICKY-N': 600,
      'SAFE-HELM-PRO': 300,
      'SAFE-VEST-HIV': 450
    };

    const initialTimestamp = new Date(now.getTime() - 70 * dayMs).toISOString();

    const moveInsert = db.prepare(`
      INSERT INTO stock_movements (
        business_id, product_id, location_id, change_qty, balance_after, reason, order_line_id, source_tag, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const currentBalances = {};

    for (const [sku, qty] of Object.entries(initialQtys)) {
      const prod = productMap[sku];
      currentBalances[prod.id] = qty;
      moveInsert.run(
        businessId,
        prod.id,
        locWh,
        qty,
        qty,
        'INITIAL_INVENTORY_COUNT',
        null,
        prod.source_tag,
        initialTimestamp
      );
    }

    // 6. Generate 55 Days of Realistic Daily Sales History
    // Simulates natural variance, weekday peaks, and a stockout event for ELEC-MECH-KB
    const orderInsert = db.prepare(`
      INSERT INTO orders (
        business_id, contact_id, order_number, type, status, order_date, due_date, total_cents, paid_cents, notes, allow_backorder, source_tag, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const lineInsert = db.prepare(`
      INSERT INTO order_lines (
        order_id, product_id, quantity, pack_quantity, unit_price_cents, tax_cents, discount_cents, total_cents
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const paymentInsert = db.prepare(`
      INSERT INTO payment_allocations (
        order_id, amount_cents, payment_method, notes, recorded_at
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const customers = [custMetro, custCoast, custCascade, custSummit];
    let orderSeq = 1000;

    for (let dayOffset = 65; dayOffset >= 5; dayOffset--) {
      const orderDate = new Date(now.getTime() - dayOffset * dayMs);
      const dayOfWeek = orderDate.getUTCDay(); // 0 is Sunday, 6 is Saturday
      // Wholesale demand is higher on Tue-Fri
      const demandMultiplier = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.3 : (dayOfWeek === 3 || dayOfWeek === 4 ? 1.4 : 1.0);

      // Create 1-3 sales orders per active day
      const numOrders = Math.floor(1 + Math.random() * 2 * demandMultiplier);

      for (let o = 0; o < numOrders; o++) {
        orderSeq++;
        const custId = customers[orderSeq % customers.length];
        const orderNumber = `SO-${orderSeq}`;
        const dueDate = new Date(orderDate.getTime() + 15 * dayMs).toISOString();

        // Select 2-4 products for this order
        const orderLines = [];
        let orderTotalCents = 0;

        for (const [sku, prod] of Object.entries(productMap)) {
          // If item is ELEC-MECH-KB around dayOffset 25-18, simulate a stockout!
          if (sku === 'ELEC-MECH-KB' && dayOffset >= 18 && dayOffset <= 25) {
            continue; // stockout period
          }

          if (Math.random() < 0.35 * demandMultiplier) {
            const baseQty = Math.max(1, Math.round((Math.random() * 4 + 1) * prod.pack_size));
            const available = currentBalances[prod.id] || 0;
            const saleQty = Math.min(baseQty, Math.max(0, available));

            if (saleQty > 0) {
              const lineTotal = saleQty * prod.sell_price_cents;
              orderLines.push({
                product: prod,
                quantity: saleQty,
                pack_quantity: Math.ceil(saleQty / prod.pack_size),
                unit_price_cents: prod.sell_price_cents,
                total_cents: lineTotal
              });
              orderTotalCents += lineTotal;
            }
          }
        }

        if (orderLines.length === 0) continue;

        // Fulfill historical orders completely
        const isPaid = dayOffset > 20; // older orders are fully paid, recent ones may have partial or open AR
        const paidCents = isPaid ? orderTotalCents : (dayOffset > 10 ? Math.floor(orderTotalCents * 0.5) : 0);

        const orderRes = orderInsert.run(
          businessId,
          custId,
          orderNumber,
          'SALE',
          'FULFILLED',
          orderDate.toISOString(),
          dueDate,
          orderTotalCents,
          paidCents,
          'Historical wholesale fulfillment',
          0,
          'UCI_RETAIL',
          orderDate.toISOString()
        );
        const orderId = orderRes.lastInsertRowid;

        // Deduct stock ledger for fulfilled order
        for (const line of orderLines) {
          const lineRes = lineInsert.run(
            orderId,
            line.product.id,
            line.quantity,
            line.pack_quantity,
            line.unit_price_cents,
            0,
            0,
            line.total_cents
          );
          const lineId = lineRes.lastInsertRowid;

          const newBal = (currentBalances[line.product.id] || 0) - line.quantity;
          currentBalances[line.product.id] = newBal;

          moveInsert.run(
            businessId,
            line.product.id,
            locWh,
            -line.quantity,
            newBal,
            'SALE_FULFILLMENT',
            lineId,
            line.product.source_tag,
            orderDate.toISOString()
          );
        }

        // Record payment allocations if paid
        if (paidCents > 0) {
          const payDate = new Date(orderDate.getTime() + 5 * dayMs).toISOString();
          paymentInsert.run(orderId, paidCents, 'BANK_TRANSFER', 'Payment applied to order', payDate);
        }
      }
    }

    // 7. Add Open Confirmed Orders for Reserved Stock and Pending AR
    const openSoDate = new Date(now.getTime() - 2 * dayMs).toISOString();
    const openSoDue = new Date(now.getTime() + 10 * dayMs).toISOString();

    const openSoRes = orderInsert.run(
      businessId,
      custMetro,
      `SO-${++orderSeq}`,
      'SALE',
      'CONFIRMED', // Reserved stock!
      openSoDate,
      openSoDue,
      0, // will update
      0,
      'Pending dispatch to Metro Hub',
      0,
      'SYNTHETIC',
      openSoDate
    );
    const openSoId = openSoRes.lastInsertRowid;

    let openSoTotal = 0;
    const reservedItems = [
      { sku: 'ELEC-USB-C2M', qty: 30 },
      { sku: 'ELEC-HDMI-4K',  qty: 20 },
      { sku: 'CONS-COPY-A4',  qty: 25 }
    ];

    for (const it of reservedItems) {
      const prod = productMap[it.sku];
      const lineCost = it.qty * prod.sell_price_cents;
      openSoTotal += lineCost;
      lineInsert.run(
        openSoId,
        prod.id,
        it.qty,
        Math.ceil(it.qty / prod.pack_size),
        prod.sell_price_cents,
        0,
        0,
        lineCost
      );
    }
    db.prepare('UPDATE orders SET total_cents = ? WHERE id = ?').run(openSoTotal, openSoId);

    // 8. Add Confirmed Purchase Order for Incoming Stock & Pending AP
    const poDate = new Date(now.getTime() - 3 * dayMs).toISOString();
    const poDue = new Date(now.getTime() + 7 * dayMs).toISOString();

    const poRes = orderInsert.run(
      businessId,
      supTech,
      `PO-2001`,
      'PURCHASE',
      'CONFIRMED', // Incoming PO!
      poDate,
      poDue,
      0, // will update
      150000, // $1,500 advance deposit paid
      'Restock order for Micro Tech electronics',
      0,
      'SYNTHETIC',
      poDate
    );
    const poId = poRes.lastInsertRowid;

    let poTotal = 0;
    const incomingItems = [
      { sku: 'ELEC-USB-C2M', qty: 100 },
      { sku: 'ELEC-HDMI-4K',  qty: 50 }
    ];

    for (const it of incomingItems) {
      const prod = productMap[it.sku];
      const lineCost = it.qty * prod.cost_price_cents;
      poTotal += lineCost;
      lineInsert.run(
        poId,
        prod.id,
        it.qty,
        Math.ceil(it.qty / prod.pack_size),
        prod.cost_price_cents,
        0,
        0,
        lineCost
      );
    }
    db.prepare('UPDATE orders SET total_cents = ? WHERE id = ?').run(poTotal, poId);

    // Record the $1,500 advance deposit
    paymentInsert.run(poId, 150000, 'BANK_TRANSFER', 'Advance supplier payment deposit', poDate);

    // 9. Seed B2B Wholesale Profile & Listings
    db.prepare(`
      INSERT OR REPLACE INTO b2b_profiles (
        business_id, public_name, category, city, gst_or_reg_no, is_verified, min_order_cents, delivery_days, is_public, description
      ) VALUES (?, ?, ?, ?, ?, 1, 25000, 2, 1, ?)
    `).run(
      businessId,
      'Vanguard Wholesale Distribution Corp',
      'Industrial, IT & Workplace Consumables',
      'Seattle Distribution Center (Metro Hub)',
      'GST-9921-VAN-01',
      'Premier regional B2B wholesale fulfillment hub supplying high-velocity commercial goods with verified 48h dispatch.'
    );

    // List 4 core products on B2B
    const b2bListSkus = ['CONS-COPY-A4', 'ELEC-USB-C2M', 'ELEC-HDMI-4K', 'SAFE-HELM-PRO'];
    for (const sku of b2bListSkus) {
      const p = productMap[sku];
      if (p) {
        db.prepare(`
          UPDATE products 
          SET is_b2b_listed = 1, b2b_price_cents = ?, b2b_moq = 5
          WHERE id = ?
        `).run(Math.round(p.sell_price_cents * 0.85), p.id);
      }
    }

    // Seed Verified Partner B2B Business (Pacific Coast Trade Logistics)
    const existingPartner = db.prepare("SELECT id FROM businesses WHERE slug = 'partner-pacific-wholesale' LIMIT 1").get();
    let partnerBizId;
    if (!existingPartner) {
      const pRes = db.prepare(`
        INSERT INTO businesses (name, slug, currency, timezone, operating_cash_cents, cash_reserve_cents, is_demo)
        VALUES ('Pacific Coast Trade Logistics', 'partner-pacific-wholesale', 'USD', 'America/Los_Angeles', 25000000, 5000000, 0)
      `).run();
      partnerBizId = pRes.lastInsertRowid;
    } else {
      partnerBizId = existingPartner.id;
    }

    db.prepare(`
      INSERT OR REPLACE INTO b2b_profiles (
        business_id, public_name, category, city, gst_or_reg_no, is_verified, min_order_cents, delivery_days, is_public, description
      ) VALUES (?, ?, ?, ?, ?, 1, 15000, 3, 1, ?)
    `).run(
      partnerBizId,
      'Pacific Coast Trade Logistics',
      'Office Automation, Cables & Safety Hardware',
      'Portland Logistics Park',
      'GST-8812-PAC-02',
      'Direct manufacturer distributor with nationwide pallet shipping and verified stock guarantees.'
    );

    // Partner products (matching SKUs to enable Smart Restock Matches!)
    const partnerProducts = [
      { sku: 'CONS-COPY-A4', name: 'A4 Bright White Paper (500s Ream)', cat: 'Consumables', b2bPrice: 520, moq: 10, stock: 850 },
      { sku: 'ELEC-MECH-KB', name: 'Ergonomic Mechanical Keyboard', cat: 'Electronics', b2bPrice: 4200, moq: 2, stock: 120 },
      { sku: 'SAFE-VEST-HIV', name: 'High-Visibility Safety Vest (Class 2)', cat: 'Safety Gear', b2bPrice: 850, moq: 5, stock: 400 }
    ];

    for (const pp of partnerProducts) {
      const existProd = db.prepare('SELECT id FROM products WHERE business_id = ? AND sku = ?').get(partnerBizId, pp.sku);
      let ppId;
      if (!existProd) {
        const ins = db.prepare(`
          INSERT INTO products (
            business_id, sku, barcode, name, category, base_unit, pack_size, lead_days,
            min_safety_stock, cost_price_cents, sell_price_cents, is_b2b_listed, b2b_price_cents, b2b_moq
          ) VALUES (?, ?, ?, ?, ?, 'units', 5, 3, 10, ?, ?, 1, ?, ?)
        `).run(
          partnerBizId, pp.sku, pp.sku, pp.name, pp.cat,
          Math.round(pp.b2bPrice * 0.75), pp.b2bPrice, pp.b2bPrice, pp.moq
        );
        ppId = ins.lastInsertRowid;
        db.prepare(`
          INSERT INTO stock_movements (business_id, product_id, location_id, change_qty, balance_after, reason)
          VALUES (?, ?, 1, ?, ?, 'INITIAL_B2B_PARTNER_STOCK')
        `).run(partnerBizId, ppId, pp.stock, pp.stock);
      }
    }
  });

  seedTx();
  return businessId;
}

if (require.main === module) {
  const bizId = seedDatabase();
  console.log(`Successfully seeded database for business #${bizId}`);
}

module.exports = { seedDatabase };
