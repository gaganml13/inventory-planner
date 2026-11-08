const fs = require('fs');
const path = require('path');

// Auto-detect whether project uses better-sqlite3 or sqlite3
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  Database = null;
}

const dbPath = path.resolve('./inventory.db');
if (!fs.existsSync(dbPath)) {
  console.error('Database file not found at:', dbPath);
  process.exit(1);
}

if (Database) {
  const db = new Database(dbPath);

  const biz = db.prepare("SELECT id FROM businesses WHERE name LIKE '%AlgoTraders%' OR id LIKE '%gagan%' LIMIT 1").get()
           || db.prepare("SELECT id FROM businesses LIMIT 1").get();
  const bizId = biz ? biz.id : 'default';

  const p1 = db.prepare("SELECT id FROM products WHERE sku = 'TEST-FAST-01'").get();
  const p2 = db.prepare("SELECT id FROM products WHERE sku = 'TEST-STEADY-02'").get();
  const p3 = db.prepare("SELECT id FROM products WHERE sku = 'TEST-LUMPY-03'").get();

  if (!p1 || !p2 || !p3) {
    console.error('Missing SKUs! Please import the 3 SKUs in the Catalog modal first.');
    process.exit(1);
  }

  console.log('Seeding sales history for business ID:', bizId);

  const insertOrder = db.prepare("INSERT OR REPLACE INTO orders (id, business_id, type, status, total_cents, paid_cents, created_at) VALUES (?, ?, 'SALE', 'FULFILLED', ?, ?, ?)");
  const insertLine = db.prepare("INSERT OR REPLACE INTO order_lines (id, order_id, product_id, quantity, pack_quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)");

  const seed = db.transaction(() => {
    for (let i = 35; i >= 1; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0] + ' 12:00:00';
      const orderId = `ORD-HIST-${i}`;

      insertOrder.run(orderId, bizId, 7500, 7500, dateStr);

      const isWeekend = (d.getDay() === 0 || d.getDay() === 6);
      const q1 = isWeekend ? (8 + (i % 4)) : (22 + (i % 8));
      insertLine.run(`LINE-${i}-1`, orderId, p1.id, q1, 1, 350);

      const q2 = isWeekend ? 0 : (5 + (i % 3));
      insertLine.run(`LINE-${i}-2`, orderId, p2.id, q2, 1, 600);

      const q3 = (i % 6 === 0) ? 25 : 0;
      insertLine.run(`LINE-${i}-3`, orderId, p3.id, q3, 1, 900);
    }
  });

  seed();
  console.log('Successfully injected 35 days of sales records for TEST-FAST-01, TEST-STEADY-02, and TEST-LUMPY-03!');
} else {
  // Fallback to async sqlite3 driver
  const sqlite3 = require('sqlite3').verbose();
  const db = new sqlite3.Database(dbPath);

  db.get("SELECT id FROM businesses WHERE name LIKE '%AlgoTraders%' OR id LIKE '%gagan%' LIMIT 1", (err, biz) => {
    const bizId = biz ? biz.id : 'default';

    db.all("SELECT id, sku FROM products WHERE sku IN ('TEST-FAST-01', 'TEST-STEADY-02', 'TEST-LUMPY-03')", (err, products) => {
      const pMap = {};
      (products || []).forEach(p => pMap[p.sku] = p.id);

      if (!pMap['TEST-FAST-01'] || !pMap['TEST-STEADY-02'] || !pMap['TEST-LUMPY-03']) {
        console.error('Missing SKUs! Please import the 3 SKUs in the Catalog modal first.');
        db.close();
        return;
      }

      console.log('Seeding sales history for business ID:', bizId);
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        for (let i = 35; i >= 1; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dateStr = d.toISOString().split('T')[0] + ' 12:00:00';
          const orderId = `ORD-HIST-${i}`;

          db.run("INSERT OR REPLACE INTO orders (id, business_id, type, status, total_cents, paid_cents, created_at) VALUES (?, ?, 'SALE', 'FULFILLED', 7500, 7500, ?)", [orderId, bizId, dateStr]);

          const isWeekend = (d.getDay() === 0 || d.getDay() === 6);
          const q1 = isWeekend ? (8 + (i % 4)) : (22 + (i % 8));
          db.run("INSERT OR REPLACE INTO order_lines (id, order_id, product_id, quantity, pack_quantity, unit_price_cents) VALUES (?, ?, ?, ?, 1, 350)", [`LINE-${i}-1`, orderId, pMap['TEST-FAST-01'], q1]);

          const q2 = isWeekend ? 0 : (5 + (i % 3));
          db.run("INSERT OR REPLACE INTO order_lines (id, order_id, product_id, quantity, pack_quantity, unit_price_cents) VALUES (?, ?, ?, ?, 1, 600)", [`LINE-${i}-2`, orderId, pMap['TEST-STEADY-02'], q2]);

          const q3 = (i % 6 === 0) ? 25 : 0;
          db.run("INSERT OR REPLACE INTO order_lines (id, order_id, product_id, quantity, pack_quantity, unit_price_cents) VALUES (?, ?, ?, ?, 1, 900)", [`LINE-${i}-3`, orderId, pMap['TEST-LUMPY-03'], q3]);
        }
        db.run('COMMIT', () => {
          console.log('Successfully injected 35 days of sales records for TEST-FAST-01, TEST-STEADY-02, and TEST-LUMPY-03!');
          db.close();
        });
      });
    });
  });
}
