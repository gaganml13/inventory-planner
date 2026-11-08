/**
 * db.js — SQLite Database layer for Inventory Planner
 *
 * Implements clean-room synthesis from InvenTree inventory models:
 *   - StockLocation: id, name, description (stock/models.py)
 *   - Part: name, category, units, minimum_stock (part/models.py)
 *   - StockItem: quantity, location_id, unique serial/SKU (stock/models.py)
 *   - StockItemTracking: transaction audit log with change_type (IN/OUT/ADJUST), delta, notes, timestamp
 *
 * Supports both Node.js built-in `node:sqlite` (Node 22.5.0+, Node 24+) and `better-sqlite3`.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'inventory.db');

let dbInstance = null;

/**
 * Creates and wraps the SQLite database instance for unified query execution.
 */
function getDb() {
  if (dbInstance) return dbInstance;

  let rawDb;
  let isBetterSqlite = false;

  // Try better-sqlite3 first if available, else fall back to Node's native node:sqlite
  try {
    const BetterSqlite3 = require('better-sqlite3');
    rawDb = new BetterSqlite3(DB_PATH);
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('foreign_keys = ON');
    isBetterSqlite = true;
  } catch (err) {
    const { DatabaseSync } = require('node:sqlite');
    rawDb = new DatabaseSync(DB_PATH);
    rawDb.exec('PRAGMA journal_mode = WAL;');
    rawDb.exec('PRAGMA foreign_keys = ON;');
  }

  // Unified statement wrapper to ensure consistent parameter handling
  const normalizeParam = (p) => (p === undefined ? null : p);

  dbInstance = {
    exec(sql) {
      return rawDb.exec(sql);
    },
    prepare(sql) {
      const stmt = rawDb.prepare(sql);
      return {
        run(...params) {
          const cleanParams = params.map(normalizeParam);
          const res = stmt.run(...cleanParams);
          return {
            changes: res.changes,
            lastInsertRowid: Number(res.lastInsertRowid)
          };
        },
        get(...params) {
          const cleanParams = params.map(normalizeParam);
          const row = stmt.get(...cleanParams);
          return row ? { ...row } : undefined;
        },
        all(...params) {
          const cleanParams = params.map(normalizeParam);
          const rows = stmt.all(...cleanParams);
          return rows.map((r) => ({ ...r }));
        }
      };
    },
    transaction(fn) {
      if (isBetterSqlite && typeof rawDb.transaction === 'function') {
        return rawDb.transaction(fn);
      }
      return (...args) => {
        rawDb.exec('BEGIN');
        try {
          const result = fn(...args);
          rawDb.exec('COMMIT');
          return result;
        } catch (err) {
          rawDb.exec('ROLLBACK');
          throw err;
        }
      };
    }
  };

  return dbInstance;
}

/**
 * Initializes the database schema with constraints and foreign keys.
 */
function initSchema() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT    DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sku           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      name          TEXT    NOT NULL,
      category      TEXT    NOT NULL DEFAULT 'Uncategorized',
      quantity      INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
      min_threshold INTEGER NOT NULL DEFAULT 0 CHECK(min_threshold >= 0),
      unit          TEXT    NOT NULL DEFAULT 'pcs',
      location_id   INTEGER REFERENCES locations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS stock_transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      change_type TEXT    NOT NULL CHECK(change_type IN ('IN', 'OUT', 'ADJUST')),
      quantity    INTEGER NOT NULL,
      notes       TEXT    DEFAULT '',
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

/**
 * Seeds realistic inventory data if tables are empty.
 */
function seedData() {
  const db = getDb();

  const countRow = db.prepare('SELECT COUNT(*) AS count FROM locations').get();
  if (countRow && countRow.count > 0) {
    return; // Already seeded
  }

  const insertLocation = db.prepare(
    'INSERT INTO locations (name, description) VALUES (?, ?)'
  );
  const insertItem = db.prepare(`
    INSERT INTO items (sku, name, category, quantity, min_threshold, unit, location_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTx = db.prepare(`
    INSERT INTO stock_transactions (item_id, change_type, quantity, notes)
    VALUES (?, 'IN', ?, 'Initial stock receipt')
  `);

  const seedTx = db.transaction(() => {
    const locWh = insertLocation.run('Main Warehouse', 'Primary bulk distribution center').lastInsertRowid;
    const locShelf = insertLocation.run('Shelf A-3', 'High-density component bin rack').lastInsertRowid;
    const locCold = insertLocation.run('Cold Storage', 'Temperature-monitored sealed room').lastInsertRowid;
    const locService = insertLocation.run('Service Desk', 'Point-of-use assembly consumables').lastInsertRowid;

    const sampleItems = [
      ['ELEC-001', 'USB-C Cable 2m',             'Electronics',  120, 20, 'pcs',   locWh],
      ['ELEC-002', 'HDMI 2.1 Ultra Cable',       'Electronics',   45, 15, 'pcs',   locWh],
      ['ELEC-003', 'Ergonomic Wireless Mouse',   'Electronics',   18, 10, 'pcs',   locShelf],
      ['ELEC-004', 'RGB Mechanical Keyboard',    'Electronics',    4, 10, 'pcs',   locShelf],
      ['ELEC-005', 'USB 3.0 Powered Hub 7-Port', 'Electronics',   60,  8, 'pcs',   locWh],
      ['FURN-001', 'Ergonomic Mesh Chair',       'Furniture',     12,  5, 'pcs',   locWh],
      ['FURN-002', 'Motorized Standing Desk',    'Furniture',      3,  4, 'pcs',   locWh],
      ['FURN-003', 'Dual Monitor Arm',           'Furniture',      7,  3, 'pcs',   locWh],
      ['CONS-001', 'A4 Premium Paper (500 sht)', 'Consumables',   80, 30, 'reams', locService],
      ['CONS-002', 'Gel Pens Black (Box of 50)', 'Consumables',   22, 10, 'boxes', locService],
      ['CONS-003', 'Sticky Notes 3x3 (Pack 12)', 'Consumables',   14, 20, 'packs', locService],
      ['CONS-004', 'Hand Sanitizer 500ml Gel',   'Consumables',    5, 15, 'btls',  locService],
      ['FOOD-001', 'Artisan Coffee Beans 1kg',   'Pantry',        30, 10, 'packs', locCold],
      ['FOOD-002', 'Organic Green Tea (100pk)',  'Pantry',         8, 10, 'packs', locCold],
      ['SAFE-001', 'Hard Hat Safety Helmet',     'Safety',        25,  8, 'pcs',   locWh],
      ['SAFE-002', 'High-Visibility Safety Vest','Safety',         3, 10, 'pcs',   locWh]
    ];

    for (const item of sampleItems) {
      const res = insertItem.run(...item);
      insertTx.run(res.lastInsertRowid, item[3]);
    }
  });

  seedTx();
}

/**
 * List all items with optional search and category filters.
 */
function listItems({ search, category } = {}) {
  const db = getDb();
  let sql = `
    SELECT 
      i.id,
      i.sku,
      i.name,
      i.category,
      i.quantity,
      i.min_threshold,
      i.unit,
      i.location_id,
      l.name AS location_name
    FROM items i
    LEFT JOIN locations l ON i.location_id = l.id
    WHERE 1=1
  `;
  const params = [];

  if (search && search.trim()) {
    sql += ' AND (i.name LIKE ? OR i.sku LIKE ?)';
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }

  if (category && category.trim()) {
    sql += ' AND i.category = ?';
    params.push(category.trim());
  }

  sql += ' ORDER BY i.name ASC';
  return db.prepare(sql).all(...params);
}

/**
 * Get items where quantity <= min_threshold.
 */
function getLowStockItems() {
  const db = getDb();
  return db.prepare(`
    SELECT 
      i.id,
      i.sku,
      i.name,
      i.category,
      i.quantity,
      i.min_threshold,
      i.unit,
      i.location_id,
      l.name AS location_name
    FROM items i
    LEFT JOIN locations l ON i.location_id = l.id
    WHERE i.quantity <= i.min_threshold
    ORDER BY (i.quantity - i.min_threshold) ASC, i.name ASC
  `).all();
}

/**
 * Get single item by ID.
 */
function getItemById(id) {
  const db = getDb();
  return db.prepare(`
    SELECT 
      i.id,
      i.sku,
      i.name,
      i.category,
      i.quantity,
      i.min_threshold,
      i.unit,
      i.location_id,
      l.name AS location_name
    FROM items i
    LEFT JOIN locations l ON i.location_id = l.id
    WHERE i.id = ?
  `).get(id);
}

/**
 * Create a new item with unique SKU validation.
 */
function createItem({ sku, name, category, quantity, min_threshold, unit, location_id }) {
  const db = getDb();

  const trimmedSku = String(sku || '').trim().toUpperCase();
  const trimmedName = String(name || '').trim();

  if (!trimmedSku || !trimmedName) {
    const err = new Error('SKU and name are required');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  // Check unique SKU
  const existing = db.prepare('SELECT id FROM items WHERE sku = ? COLLATE NOCASE').get(trimmedSku);
  if (existing) {
    const err = new Error(`Item with SKU '${trimmedSku}' already exists`);
    err.code = 'DUPLICATE_SKU';
    throw err;
  }

  const initialQty = Math.max(0, parseInt(quantity, 10) || 0);
  const minThreshold = Math.max(0, parseInt(min_threshold, 10) || 0);
  const itemCategory = (category && String(category).trim()) || 'Uncategorized';
  const itemUnit = (unit && String(unit).trim()) || 'pcs';
  const locId = location_id ? parseInt(location_id, 10) : null;

  let createdItemId;

  const createTx = db.transaction(() => {
    const res = db.prepare(`
      INSERT INTO items (sku, name, category, quantity, min_threshold, unit, location_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(trimmedSku, trimmedName, itemCategory, initialQty, minThreshold, itemUnit, locId);

    createdItemId = res.lastInsertRowid;

    if (initialQty > 0) {
      db.prepare(`
        INSERT INTO stock_transactions (item_id, change_type, quantity, notes)
        VALUES (?, 'IN', ?, 'Initial stock receipt upon creation')
      `).run(createdItemId, initialQty);
    }
  });

  createTx();
  return getItemById(createdItemId);
}

/**
 * Adjust stock with strict non-negative validation and audit logging.
 */
function adjustStock({ item_id, change_type, quantity, notes }) {
  const db = getDb();

  const id = parseInt(item_id, 10);
  const qty = parseInt(quantity, 10);
  const type = String(change_type || '').toUpperCase();

  if (!id || isNaN(qty) || qty < 0) {
    const err = new Error('Valid item_id and non-negative quantity are required');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  if (!['IN', 'OUT', 'ADJUST'].includes(type)) {
    const err = new Error("change_type must be 'IN', 'OUT', or 'ADJUST'");
    err.code = 'INVALID_CHANGE_TYPE';
    throw err;
  }

  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!item) {
    const err = new Error(`Item with ID ${id} not found`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  let newQuantity;
  let loggedQuantity = qty;

  if (type === 'IN') {
    newQuantity = item.quantity + qty;
  } else if (type === 'OUT') {
    newQuantity = item.quantity - qty;
    if (newQuantity < 0) {
      const err = new Error(`Insufficient stock for ${item.sku}. In stock: ${item.quantity}, requested: ${qty}`);
      err.code = 'INSUFFICIENT_STOCK';
      throw err;
    }
  } else if (type === 'ADJUST') {
    newQuantity = qty;
  }

  const adjustTx = db.transaction(() => {
    db.prepare('UPDATE items SET quantity = ? WHERE id = ?').run(newQuantity, id);
    db.prepare(`
      INSERT INTO stock_transactions (item_id, change_type, quantity, notes)
      VALUES (?, ?, ?, ?)
    `).run(id, type, loggedQuantity, (notes && String(notes).trim()) || '');
  });

  adjustTx();
  return getItemById(id);
}

/**
 * Retrieve transaction audit logs.
 */
function listTransactions({ limit = 50, item_id } = {}) {
  const db = getDb();
  let sql = `
    SELECT 
      st.id,
      st.item_id,
      st.change_type,
      st.quantity,
      st.notes,
      st.created_at,
      i.name AS item_name,
      i.sku
    FROM stock_transactions st
    JOIN items i ON st.item_id = i.id
    WHERE 1=1
  `;
  const params = [];

  if (item_id) {
    sql += ' AND st.item_id = ?';
    params.push(parseInt(item_id, 10));
  }

  sql += ' ORDER BY st.id DESC LIMIT ?';
  params.push(Math.min(parseInt(limit, 10) || 50, 500));

  return db.prepare(sql).all(...params);
}

/**
 * List all storage locations.
 */
function listLocations() {
  const db = getDb();
  return db.prepare('SELECT id, name, description FROM locations ORDER BY name ASC').all();
}

/**
 * Get dashboard overview metrics.
 */
function getMetrics() {
  const db = getDb();
  const totalItems = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  const activeSkus = db.prepare('SELECT COUNT(DISTINCT sku) AS n FROM items WHERE quantity > 0').get().n;
  const lowStock = db.prepare('SELECT COUNT(*) AS n FROM items WHERE quantity <= min_threshold').get().n;
  return { totalItems, activeSkus, lowStock };
}

module.exports = {
  getDb,
  initSchema,
  seedData,
  listItems,
  getLowStockItems,
  getItemById,
  createItem,
  adjustStock,
  listTransactions,
  listLocations,
  getMetrics
};
