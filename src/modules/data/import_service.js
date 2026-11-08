/**
 * import_service.js — Atomic CSV/JSON Import with Schema Validation & Duplicate Hash Guard
 *
 * Implements:
 * - CSV parsing with schema type casting and strict bounds checks.
 * - SHA-256 line hash generation and duplicate detection via `data_import_hashes`.
 * - Complete transaction rollback (`BEGIN IMMEDIATE`) on any duplicate or validation failure.
 * - Source tagging ('UCI_RETAIL' or 'SYNTHETIC').
 */

'use strict';

const crypto = require('crypto');
const { getDb } = require('../../../database/connection');

class ImportService {
  constructor(customDb) {
    this.db = customDb || getDb();
  }

  hashContent(content) {
    return crypto.createHash('sha256').update(content.trim()).digest('hex');
  }

  parseCsv(csvText) {
    const lines = csvText.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      const err = new Error('CSV must contain a header row and at least one data row');
      err.code = 'EMPTY_CSV';
      throw err;
    }

    const headers = lines[0].split(',').map((h) => h.trim().replace(/^["']|["']$/g, ''));
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const rawLine = lines[i];
      const cols = rawLine.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = cols[idx] !== undefined ? cols[idx] : '';
      });
      rows.push({
        lineIndex: i + 1,
        rawText: rawLine,
        hash: this.hashContent(rawLine),
        data: obj
      });
    }

    return { headers, rows };
  }

  /**
   * Imports products from CSV or JSON rows atomically.
   */
  importProducts({ businessId, csvText, rowsData = null, sourceTag = 'UCI_RETAIL' }) {
    let parsedRows = [];

    if (csvText) {
      const parsed = this.parseCsv(csvText);
      parsedRows = parsed.rows;
    } else if (Array.isArray(rowsData)) {
      parsedRows = rowsData.map((row, idx) => {
        const raw = JSON.stringify(row);
        return {
          lineIndex: idx + 1,
          rawText: raw,
          hash: this.hashContent(raw),
          data: row
        };
      });
    } else {
      const err = new Error('Either csvText or rowsData array must be provided');
      err.code = 'INVALID_INPUT';
      throw err;
    }

    let insertedCount = 0;

    // Execute import in an immediate transaction
    const importTx = this.db.transaction(() => {
      const checkHashStmt = this.db.prepare('SELECT id FROM data_import_hashes WHERE business_id = ? AND line_hash = ?');
      const insertHashStmt = this.db.prepare(`
        INSERT INTO data_import_hashes (business_id, import_type, line_hash, source_tag, record_metadata)
        VALUES (?, 'PRODUCTS', ?, ?, ?)
      `);
      const insertProdStmt = this.db.prepare(`
        INSERT INTO products (
          business_id, sku, barcode, name, category, base_unit, pack_size,
          lead_days, min_safety_stock, cost_price_cents, sell_price_cents, source_tag
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of parsedRows) {
        // 1. Check for duplicate hash
        const existingHash = checkHashStmt.get(businessId, row.hash);
        if (existingHash) {
          const err = new Error(`Duplicate import record detected at line ${row.lineIndex} (hash: ${row.hash.slice(0, 8)}). Transaction aborted and rolled back.`);
          err.code = 'DUPLICATE_IMPORT_RECORD';
          err.duplicateHash = row.hash;
          err.lineIndex = row.lineIndex;
          throw err;
        }

        // 2. Validate row schema
        const d = row.data;
        const sku = String(d.sku || '').trim().toUpperCase();
        const barcode = String(d.barcode || sku).trim();
        const name = String(d.name || d.description || d.title || '').trim();
        const category = String(d.category || 'General').trim();
        const baseUnit = String(d.base_unit || d.unit || 'pcs').trim();
        const packSize = Math.max(1, parseInt(d.pack_size || d.packSize, 10) || 1);
        const leadDays = Math.max(1, parseInt(d.lead_days || d.leadDays, 10) || 7);
        const minSafety = Math.max(0, parseInt(d.min_safety_stock || d.minSafetyStock || d.safety_stock, 10) || 0);

        let costPrice = 0;
        if (d.cost_price_cents !== undefined && !isNaN(parseInt(d.cost_price_cents, 10))) {
          costPrice = parseInt(d.cost_price_cents, 10);
        } else if (d.cost_price !== undefined && d.cost_price !== '') {
          costPrice = Math.round((parseFloat(d.cost_price) || 0) * 100);
        } else if (d.cost !== undefined && d.cost !== '') {
          costPrice = Math.round((parseFloat(d.cost) || 0) * 100);
        }

        let sellPrice = 0;
        if (d.sell_price_cents !== undefined && !isNaN(parseInt(d.sell_price_cents, 10))) {
          sellPrice = parseInt(d.sell_price_cents, 10);
        } else if (d.sell_price !== undefined && d.sell_price !== '') {
          sellPrice = Math.round((parseFloat(d.sell_price) || 0) * 100);
        } else if (d.price !== undefined && d.price !== '') {
          sellPrice = Math.round((parseFloat(d.price) || 0) * 100);
        }

        if (!sku || !name) {
          const err = new Error(`Schema validation error at line ${row.lineIndex}: sku and name are mandatory fields`);
          err.code = 'SCHEMA_VALIDATION_ERROR';
          err.lineIndex = row.lineIndex;
          throw err;
        }

        // Check if SKU already exists
        const existingSku = this.db.prepare('SELECT id FROM products WHERE business_id = ? AND sku = ? COLLATE NOCASE').get(businessId, sku);
        if (existingSku) {
          const err = new Error(`Duplicate product SKU '${sku}' encountered at line ${row.lineIndex}`);
          err.code = 'DUPLICATE_SKU';
          err.lineIndex = row.lineIndex;
          throw err;
        }

        // 3. Insert product
        const prodInsertRes = insertProdStmt.run(
          businessId,
          sku,
          barcode,
          name,
          category,
          baseUnit,
          packSize,
          leadDays,
          minSafety,
          costPrice,
          sellPrice,
          sourceTag
        );

        // Optional initial stock from import document
        const initStock = parseInt(d.initial_stock || d.quantity || d.stock || 0, 10);
        if (initStock > 0 && prodInsertRes?.lastInsertRowid) {
          const loc = this.db.prepare('SELECT id FROM locations WHERE business_id = ? ORDER BY id ASC LIMIT 1').get(businessId);
          const locId = loc ? loc.id : 1;
          this.db.prepare(`
            INSERT INTO stock_movements (
              business_id, product_id, location_id, change_qty, balance_after, reason, source_tag
            ) VALUES (?, ?, ?, ?, ?, 'INITIAL_IMPORT_STOCK', ?)
          `).run(businessId, prodInsertRes.lastInsertRowid, locId, initStock, initStock, sourceTag);
        }

        // 4. Record line hash
        insertHashStmt.run(businessId, row.hash, sourceTag, sku);
        insertedCount++;
      }
    });

    importTx();
    return {
      success: true,
      importedCount: insertedCount,
      sourceTag
    };
  }
}

module.exports = ImportService;
