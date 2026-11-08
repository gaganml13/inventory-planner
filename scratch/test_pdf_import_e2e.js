'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseConnection } = require('../database/connection');
const { runMigrations } = require('../database/migrator');
const { createApp } = require('../src/app');
const AuthService = require('../src/modules/auth/auth_service');

async function testPdfImportE2E() {
  const testDbPath = path.join(__dirname, 'test_pdf_import.db');
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch (_) {}
  }
  const db = new DatabaseConnection(testDbPath);
  runMigrations(db);

  db.exec(`
    INSERT INTO businesses (name, currency, is_demo) VALUES ('Vanguard Wholesale Test', 'USD', 0);
    INSERT INTO locations (business_id, name) VALUES (1, 'Main Warehouse');
  `);
  const userRes = db.prepare(`
    INSERT INTO users (business_id, email, password_hash, role) VALUES (1, 'tester@vanguard.com', 'hash', 'OWNER')
  `).run();

  const authService = new AuthService(db);
  const session = authService.createSession(userRes.lastInsertRowid, 1);
  const cookie = `session=${session.token}`;

  const app = createApp(db);
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`Server started on ${baseUrl}`);

  try {
    // 1. Test parse-document with text lines
    const parsePayload = {
      file_name: 'vendor_catalog.txt',
      text_content: [
        'SKU,Name,Category,Cost,Sell,Pack,Stock',
        'PDF-ELEC-01,High Speed USB Hub,Electronics,12.50,29.99,5,50',
        'PDF-MECH-02 | Heavy Duty Bearing | Machinery | 45.00 | 89.00 | 1 | 20'
      ].join('\n')
    };

    const parseRes = await fetch(`${baseUrl}/api/data/parse-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie || ''
      },
      body: JSON.stringify(parsePayload)
    });
    const parseData = await parseRes.json();
    console.log('Parse document response:', parseData);

    if (!parseData.success || parseData.count !== 2) {
      throw new Error(`Parse document failed: expected 2 products, got ${parseData.count}`);
    }

    // 2. Test importing extracted products into tenant
    const importRes = await fetch(`${baseUrl}/api/data/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie || ''
      },
      body: JSON.stringify({
        business_id: 1,
        rows: parseData.products,
        source_tag: 'VENDOR_FEED'
      })
    });
    const importData = await importRes.json();
    console.log('Import response:', importData);

    if (!importData.success || (importData.importedCount !== 2 && importData.imported_count !== 2)) {
      throw new Error(`Import failed: ${JSON.stringify(importData)}`);
    }

    // 3. Verify products in DB
    const prods = db.prepare('SELECT sku, name, cost_price_cents, sell_price_cents FROM products WHERE business_id = 1').all();
    console.log('Database products:', prods);
    if (prods.length !== 2) {
      throw new Error(`Expected 2 products in DB, found ${prods.length}`);
    }

    // 4. Verify stock movements
    const movements = db.prepare('SELECT product_id, change_qty, reason FROM stock_movements WHERE business_id = 1').all();
    console.log('Database stock movements:', movements);
    if (movements.length !== 2) {
      throw new Error(`Expected 2 stock movements in DB, found ${movements.length}`);
    }

    console.log('\n✅ All PDF / Document Import E2E checks passed successfully!');
  } finally {
    server.close();
    try { fs.unlinkSync(testDbPath); } catch (_) {}
  }
}

testPdfImportE2E().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
