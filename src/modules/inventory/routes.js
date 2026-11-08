/**
 * routes.js — Inventory HTTP Endpoints
 */

'use strict';

const express = require('express');
const InventoryService = require('./inventory_service');
const CycleCountService = require('./cycle_count_service');

function createInventoryRouter(db) {
  const router = express.Router();
  const service = new InventoryService(db);
  const cycleCountService = new CycleCountService(db);

  // Default business id helper (with user tenant isolation)
  const getBizId = (req) => {
    if (req.user && req.user.businessId) return req.user.businessId;
    return parseInt(req.query.business_id || req.body.business_id || 1, 10);
  };

  /** POST /api/inventory/products */
  router.post('/products', (req, res) => {
    try {
      const bizId = getBizId(req);
      const product = service.createProduct({
        businessId: bizId,
        sku: req.body.sku,
        barcode: req.body.barcode,
        name: req.body.name,
        category: req.body.category,
        base_unit: req.body.base_unit || req.body.unit,
        pack_size: req.body.pack_size,
        lead_days: req.body.lead_days,
        min_safety_stock: req.body.min_safety_stock || req.body.min_threshold,
        cost_price_cents: req.body.cost_price_cents,
        sell_price_cents: req.body.sell_price_cents,
        initial_stock: req.body.initial_stock || req.body.quantity,
        location_id: req.body.location_id
      });
      res.status(201).json(product);
    } catch (err) {
      if (err.code === 'DUPLICATE_SKU') {
        return res.status(409).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** PUT /api/inventory/products/:id */
  router.put('/products/:id', (req, res) => {
    try {
      const bizId = getBizId(req);
      const productId = parseInt(req.params.id, 10);
      const updated = service.updateProduct({
        businessId: bizId,
        productId,
        sku: req.body.sku,
        barcode: req.body.barcode,
        name: req.body.name,
        category: req.body.category,
        base_unit: req.body.base_unit || req.body.unit,
        pack_size: req.body.pack_size,
        lead_days: req.body.lead_days,
        min_safety_stock: req.body.min_safety_stock,
        cost_price_cents: req.body.cost_price_cents,
        sell_price_cents: req.body.sell_price_cents
      });
      res.json(updated);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      if (err.code === 'DUPLICATE_SKU') {
        return res.status(409).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** DELETE /api/inventory/products/:id */
  router.delete('/products/:id', (req, res) => {
    try {
      const bizId = getBizId(req);
      const productId = parseInt(req.params.id, 10);
      const result = service.deleteProduct(bizId, productId);
      res.json(result);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      if (err.code === 'PRODUCT_IN_USE') {
        return res.status(409).json({ error: true, message: err.message, code: err.code });
      }
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/inventory/products/:id/archive */
  router.post('/products/:id/archive', (req, res) => {
    try {
      const bizId = getBizId(req);
      const productId = parseInt(req.params.id, 10);
      const result = service.archiveProduct(bizId, productId);
      res.json(result);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/inventory/products/:id/unarchive */
  router.post('/products/:id/unarchive', (req, res) => {
    try {
      const bizId = getBizId(req);
      const productId = parseInt(req.params.id, 10);
      const result = service.unarchiveProduct(bizId, productId);
      res.json(result);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** GET /api/inventory/aging */
  router.get('/aging', (req, res) => {
    try {
      const bizId = getBizId(req);
      const report = service.getInventoryAging(bizId);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** GET /api/inventory/barcode/:code */
  router.get('/barcode/:code', (req, res) => {
    try {
      const bizId = getBizId(req);
      const code = String(req.params.code).trim();
      const product = db.prepare(`
        SELECT id, sku, barcode, name, category, pack_size, cost_price_cents, sell_price_cents, base_unit
        FROM products
        WHERE business_id = ? AND (barcode = ? COLLATE NOCASE OR sku = ? COLLATE NOCASE)
        LIMIT 1
      `).get(bizId, code, code);

      if (!product) {
        return res.status(404).json({ error: true, message: `No item found matching barcode/SKU '${code}'`, code: 'NOT_FOUND' });
      }

      const position = service.getStockPositions(bizId, product.id, true);
      res.json({ product, position });
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** GET /api/inventory/positions */
  router.get('/positions', (req, res) => {
    try {
      const bizId = getBizId(req);
      const includeArchived = req.query.include_archived === 'true' || req.query.archived === '1';
      const positions = service.getStockPositions(bizId, null, includeArchived);
      res.json(positions);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** GET /api/inventory/positions/:id */
  router.get('/positions/:id', (req, res) => {
    try {
      const bizId = getBizId(req);
      const includeArchived = req.query.include_archived === 'true' || req.query.archived === '1';
      const position = service.getStockPositions(bizId, parseInt(req.params.id, 10), includeArchived);
      if (!position) {
        return res.status(404).json({ error: true, message: 'Product position not found', code: 'NOT_FOUND' });
      }
      res.json(position);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/inventory/adjust */
  router.post('/adjust', (req, res) => {
    try {
      const bizId = getBizId(req);
      const productId = req.body.product_id !== undefined ? req.body.product_id : req.body.productId;
      const locationId = req.body.location_id !== undefined ? req.body.location_id : req.body.locationId;
      const changeQty = req.body.change_qty !== undefined ? req.body.change_qty : req.body.changeQty;
      const newOnHand = req.body.new_on_hand !== undefined ? req.body.new_on_hand : req.body.newOnHand;
      const reason = req.body.reason;
      const allowBackorder = req.body.allow_backorder !== undefined ? req.body.allow_backorder : req.body.allowBackorder;
      const stockType = req.body.stock_type || req.body.stockType || 'AVAILABLE';
      const reversalId = req.body.reversal_of_movement_id || req.body.reversalOfMovementId;

      if (!productId || (changeQty === undefined && newOnHand === undefined)) {
        return res.status(400).json({
          error: true,
          message: 'Please specify a product and either a quantity change (+/-) or target count',
          code: 'VALIDATION_ERROR'
        });
      }

      const updated = service.adjustStock({
        businessId: bizId,
        productId: parseInt(productId, 10),
        locationId: locationId ? parseInt(locationId, 10) : null,
        changeQty: changeQty !== undefined ? parseInt(changeQty, 10) : undefined,
        newOnHand: newOnHand !== undefined ? parseInt(newOnHand, 10) : undefined,
        reason: reason || 'MANUAL_ADJUSTMENT',
        allowBackorder: Boolean(allowBackorder),
        stockType,
        reversalOfMovementId: reversalId || null,
        userId: req.user?.id || null
      });

      res.json(updated);
    } catch (err) {
      if (err.code === 'INSUFFICIENT_STOCK') {
        return res.status(422).json({ error: true, message: err.message, code: err.code });
      }
      if (err.code === 'PRODUCT_NOT_FOUND' || err.code === 'LOCATION_NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code || 'BAD_REQUEST' });
    }
  });

  /** GET /api/inventory/movements */
  router.get('/movements', (req, res) => {
    try {
      const bizId = getBizId(req);
      const productId = req.query.product_id ? parseInt(req.query.product_id, 10) : null;
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
      const movements = service.getMovements({ businessId: bizId, productId, limit });
      res.json(movements);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** GET /api/inventory/locations */
  router.get('/locations', (req, res) => {
    try {
      const bizId = getBizId(req);
      const locations = service.getLocations(bizId);
      res.json(locations);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  // ──────────────────────────────────────────
  // Cycle Counts API (Blind Counting & Governance)
  // ──────────────────────────────────────────

  /** GET /api/inventory/cycle-counts */
  router.get('/cycle-counts', (req, res) => {
    try {
      const bizId = getBizId(req);
      const counts = cycleCountService.listCycleCounts(bizId, req.query.status || null);
      res.json(counts);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** GET /api/inventory/cycle-counts/:id */
  router.get('/cycle-counts/:id', (req, res) => {
    try {
      const bizId = getBizId(req);
      const id = parseInt(req.params.id, 10);
      const maskBlind = req.user?.role === 'WAREHOUSE';
      const cc = cycleCountService.getCycleCountById(id, bizId, maskBlind);
      if (!cc) {
        return res.status(404).json({ error: true, message: 'Cycle count not found', code: 'NOT_FOUND' });
      }
      res.json(cc);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/inventory/cycle-counts */
  router.post('/cycle-counts', (req, res) => {
    try {
      const bizId = getBizId(req);
      const locId = req.body.location_id !== undefined ? req.body.location_id : req.body.locationId;
      const countNum = req.body.count_number || req.body.countNumber;
      const isBlind = req.body.is_blind_count !== undefined 
        ? req.body.is_blind_count 
        : (req.body.blind_count !== undefined ? req.body.blind_count : (req.body.blindCount !== undefined ? req.body.blindCount : true));
      const userId = req.body.assigned_user_id || req.body.assignedUserId || req.user?.id || null;
      const prodIds = req.body.product_ids || req.body.productIds;

      const cc = cycleCountService.createCycleCount({
        businessId: bizId,
        locationId: locId ? parseInt(locId, 10) : 1,
        countNumber: countNum,
        isBlindCount: Boolean(isBlind),
        assignedUserId: userId ? parseInt(userId, 10) : null,
        productIds: Array.isArray(prodIds) ? prodIds.map(Number) : null
      });
      res.status(201).json(cc);
    } catch (err) {
      res.status(400).json({ error: true, message: err.message, code: err.code || 'BAD_REQUEST' });
    }
  });

  /** POST /api/inventory/cycle-counts/:id/counts */
  router.post('/cycle-counts/:id/counts', (req, res) => {
    try {
      const bizId = getBizId(req);
      const id = parseInt(req.params.id, 10);
      const { counts } = req.body;
      if (!Array.isArray(counts)) {
        return res.status(400).json({ error: true, message: 'counts must be an array of count objects' });
      }
      const updated = cycleCountService.recordCounts({
        cycleCountId: id,
        businessId: bizId,
        counts,
        userId: req.user?.id || null
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/inventory/cycle-counts/:id/submit */
  router.post('/cycle-counts/:id/submit', (req, res) => {
    try {
      const bizId = getBizId(req);
      const id = parseInt(req.params.id, 10);
      const updated = cycleCountService.submitForApproval(id, bizId);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/inventory/cycle-counts/:id/approve */
  router.post('/cycle-counts/:id/approve', (req, res) => {
    try {
      const bizId = getBizId(req);
      const id = parseInt(req.params.id, 10);
      const { reviewer_notes } = req.body;
      const updated = cycleCountService.approveCycleCount({
        cycleCountId: id,
        businessId: bizId,
        reviewerUserId: req.user?.id || null,
        reviewerNotes: reviewer_notes || '',
        userRole: req.user?.role || 'OWNER'
      });
      res.json(updated);
    } catch (err) {
      if (err.code === 'APPROVAL_THRESHOLD_EXCEEDED') {
        return res.status(403).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/inventory/cycle-counts/:id/reject */
  router.post('/cycle-counts/:id/reject', (req, res) => {
    try {
      const bizId = getBizId(req);
      const id = parseInt(req.params.id, 10);
      const { reviewer_notes } = req.body;
      const updated = cycleCountService.rejectCycleCount({
        cycleCountId: id,
        businessId: bizId,
        reviewerUserId: req.user?.id || null,
        reviewerNotes: reviewer_notes || ''
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  return router;
}

module.exports = createInventoryRouter;
