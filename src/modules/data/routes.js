/**
 * routes.js — Data Import & Export Endpoints
 */

'use strict';

const express = require('express');
const ImportService = require('./import_service');
const { extractTextFromPdfBuffer, parseLinesToProducts } = require('./document_parser');

function createDataRouter(db) {
  const router = express.Router();
  const service = new ImportService(db);

  const getBizId = (req) => {
    if (req.user && req.user.businessId) return req.user.businessId;
    return parseInt(req.query.business_id || req.body.business_id || 1, 10);
  };

  function escapeCsv(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function arrayToCsv(headers, rows) {
    const lines = [headers.join(',')];
    for (const row of rows) {
      lines.push(headers.map((h) => escapeCsv(row[h])).join(','));
    }
    return lines.join('\r\n');
  }

  /**
   * GET /api/data/export/catalog
   * Exports full catalog with logistics and inventory balance metrics
   */
  router.get('/export/catalog', (req, res) => {
    try {
      const bizId = getBizId(req);
      const rows = db.prepare(`
        SELECT 
          p.sku,
          p.barcode,
          p.name,
          p.category,
          p.base_unit,
          p.pack_size,
          p.lead_days,
          p.min_safety_stock,
          printf('%.2f', p.cost_price_cents / 100.0) AS cost_price,
          printf('%.2f', p.sell_price_cents / 100.0) AS sell_price,
          COALESCE(sm.on_hand, 0) AS on_hand,
          (COALESCE(sm.on_hand, 0) - COALESCE(res.reserved, 0)) AS available,
          COALESCE(inc.incoming_po, 0) AS incoming_po,
          CASE WHEN p.is_archived = 1 THEN 'YES' ELSE 'NO' END AS is_archived,
          p.created_at
        FROM products p
        LEFT JOIN (
          SELECT product_id, SUM(change_qty) AS on_hand
          FROM stock_movements WHERE business_id = ? AND (stock_type = 'AVAILABLE' OR stock_type IS NULL)
          GROUP BY product_id
        ) sm ON p.id = sm.product_id
        LEFT JOIN (
          SELECT ol.product_id, SUM(ol.quantity - COALESCE(ol.fulfilled_quantity, 0)) AS reserved
          FROM order_lines ol
          JOIN orders o ON ol.order_id = o.id
          WHERE o.business_id = ? AND o.type = 'SALE' AND o.status IN ('CONFIRMED', 'APPROVED', 'PARTIALLY_FULFILLED')
          GROUP BY ol.product_id
        ) res ON p.id = res.product_id
        LEFT JOIN (
          SELECT ol.product_id, SUM(ol.quantity - COALESCE(ol.received_quantity, 0)) AS incoming_po
          FROM order_lines ol
          JOIN orders o ON ol.order_id = o.id
          WHERE o.business_id = ? AND o.type = 'PURCHASE' AND o.status IN ('CONFIRMED', 'APPROVED', 'PARTIALLY_RECEIVED')
          GROUP BY ol.product_id
        ) inc ON p.id = inc.product_id
        WHERE p.business_id = ?
        ORDER BY p.id ASC
      `).all(bizId, bizId, bizId, bizId);

      const headers = [
        'sku', 'barcode', 'name', 'category', 'base_unit', 'pack_size',
        'lead_days', 'min_safety_stock', 'cost_price', 'sell_price',
        'on_hand', 'available', 'incoming_po', 'is_archived', 'created_at'
      ];

      const csvData = arrayToCsv(headers, rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="catalog_export_${Date.now()}.csv"`);
      res.send(csvData);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /**
   * GET /api/data/export/orders
   * Exports purchase and sales orders with financial breakdown
   */
  router.get('/export/orders', (req, res) => {
    try {
      const bizId = getBizId(req);
      const rows = db.prepare(`
        SELECT 
          o.order_number,
          o.type,
          o.status,
          c.name AS contact_name,
          c.type AS contact_type,
          o.order_date,
          o.due_date,
          printf('%.2f', o.total_cents / 100.0) AS total_amount,
          printf('%.2f', o.paid_cents / 100.0) AS paid_amount,
          printf('%.2f', (o.total_cents - o.paid_cents) / 100.0) AS balance_due,
          o.notes,
          o.created_at
        FROM orders o
        JOIN contacts c ON o.contact_id = c.id
        WHERE o.business_id = ?
        ORDER BY o.id DESC
      `).all(bizId);

      const headers = [
        'order_number', 'type', 'status', 'contact_name', 'contact_type',
        'order_date', 'due_date', 'total_amount', 'paid_amount', 'balance_due', 'notes', 'created_at'
      ];

      const csvData = arrayToCsv(headers, rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="orders_export_${Date.now()}.csv"`);
      res.send(csvData);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /**
   * GET /api/data/export/movements & /api/data/export/ledger
   * Exports immutable stock audit trail
   */
  const exportLedgerHandler = (req, res) => {
    try {
      const bizId = getBizId(req);
      const rows = db.prepare(`
        SELECT 
          sm.id AS movement_id,
          sm.created_at,
          p.sku,
          p.name AS product_name,
          l.name AS location_name,
          sm.change_qty,
          sm.balance_after,
          COALESCE(sm.stock_type, 'AVAILABLE') AS stock_type,
          sm.reason,
          COALESCE(o.order_number, sm.source_tag) AS source_document,
          u.name AS user_name
        FROM stock_movements sm
        JOIN products p ON sm.product_id = p.id
        LEFT JOIN locations l ON sm.location_id = l.id
        LEFT JOIN order_lines ol ON sm.order_line_id = ol.id
        LEFT JOIN orders o ON ol.order_id = o.id
        LEFT JOIN users u ON sm.user_id = u.id
        WHERE sm.business_id = ?
        ORDER BY sm.id DESC
      `).all(bizId);

      const headers = [
        'movement_id', 'created_at', 'sku', 'product_name', 'location_name',
        'change_qty', 'balance_after', 'stock_type', 'reason', 'source_document', 'user_name'
      ];

      const csvData = arrayToCsv(headers, rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="stock_ledger_${Date.now()}.csv"`);
      res.send(csvData);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  };

  router.get('/export/movements', exportLedgerHandler);
  router.get('/export/ledger', exportLedgerHandler);

  /**
   * POST /api/data/import
   * Body: { csv_text, source_tag } or { rows, source_tag }
   */
  router.post('/import', (req, res) => {
    try {
      const bizId = getBizId(req);
      const { csv_text, rows, source_tag } = req.body;

      const result = service.importProducts({
        businessId: bizId,
        csvText: csv_text,
        rowsData: rows,
        sourceTag: source_tag || 'UCI_RETAIL'
      });

      res.status(201).json(result);
    } catch (err) {
      if (err.code === 'DUPLICATE_IMPORT_RECORD' || err.code === 'DUPLICATE_SKU') {
        return res.status(409).json({ error: true, message: err.message, code: err.code, lineIndex: err.lineIndex });
      }
      if (err.code === 'SCHEMA_VALIDATION_ERROR' || err.code === 'EMPTY_CSV' || err.code === 'INVALID_INPUT') {
        return res.status(400).json({ error: true, message: err.message, code: err.code, lineIndex: err.lineIndex });
      }
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /**
   * POST /api/data/parse-document
   * Body: { document_base64, file_type, file_name, text_content }
   */
  router.post('/parse-document', (req, res) => {
    try {
      const { document_base64, file_type, file_name, text_content } = req.body;
      let text = text_content || '';

      if (document_base64) {
        const buffer = Buffer.from(document_base64, 'base64');
        const isPdf = (file_type && file_type.toLowerCase().includes('pdf')) || (file_name && file_name.toLowerCase().endsWith('.pdf')) || buffer.subarray(0, 5).toString() === '%PDF-';
        if (isPdf) {
          text = extractTextFromPdfBuffer(buffer);
        } else {
          text = buffer.toString('utf-8');
        }
      }

      if (!text || !text.trim()) {
        return res.status(400).json({ error: true, message: 'Could not extract text lines from document', code: 'EMPTY_DOCUMENT' });
      }

      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const products = parseLinesToProducts(lines);

      res.json({
        success: true,
        count: products.length,
        filename: file_name || 'document',
        products
      });
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: 'PARSE_FAILED' });
    }
  });

  return router;
}

module.exports = createDataRouter;
