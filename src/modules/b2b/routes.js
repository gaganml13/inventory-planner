/**
 * routes.js — B2B Wholesale Network HTTP Endpoints
 */

'use strict';

const express = require('express');
const B2bService = require('./b2b_service');

function createB2bRouter(db) {
  const router = express.Router();
  const service = new B2bService(db);

  const getBizId = (req) => {
    if (req.user && req.user.businessId) return req.user.businessId;
    return parseInt(req.query.business_id || req.body.business_id || 1, 10);
  };

  /** GET /api/b2b/directory */
  router.get('/directory', (req, res) => {
    try {
      const bizId = getBizId(req);
      const dirs = service.listDirectories(bizId);
      res.json(dirs);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /** GET /api/b2b/catalog */
  router.get('/catalog', (req, res) => {
    try {
      const bizId = getBizId(req);
      const { seller_id, category, q } = req.query;
      const catalog = service.listB2bCatalog({
        currentBusinessId: bizId,
        sellerBusinessId: seller_id ? parseInt(seller_id, 10) : null,
        category: category || null,
        query: q || null
      });
      res.json(catalog);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /** GET /api/b2b/matches (Smart Restock Matches) */
  router.get('/matches', (req, res) => {
    try {
      const bizId = getBizId(req);
      const matches = service.getRestockMatches(bizId);
      res.json(matches);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /** GET /api/b2b/orders (Inbound & Outbound Trade Orders) */
  router.get('/orders', (req, res) => {
    try {
      const bizId = getBizId(req);
      const orders = service.listTradeOrders(bizId);
      res.json(orders);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /** POST /api/b2b/orders/request */
  router.post('/orders/request', (req, res) => {
    try {
      const bizId = getBizId(req);
      const { seller_business_id, items, trade_notes } = req.body;

      if (!seller_business_id) {
        return res.status(400).json({ error: true, message: 'Please select a valid wholesale seller' });
      }
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: true, message: 'Please select at least one item to order' });
      }

      const result = service.createTradeRequest({
        buyerBusinessId: bizId,
        sellerBusinessId: parseInt(seller_business_id, 10),
        items,
        tradeNotes: trade_notes || ''
      });

      res.status(201).json(result);
    } catch (err) {
      if (err.code === 'SELF_TRADE_PROHIBITED' || err.code === 'EMPTY_ITEMS') {
        return res.status(400).json({ error: true, message: err.message, code: err.code });
      }
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /** POST /api/b2b/orders/:id/accept */
  router.post('/orders/:id/accept', (req, res) => {
    try {
      const bizId = getBizId(req);
      const result = service.acceptTradeOrder(parseInt(req.params.id, 10), bizId);
      res.json(result);
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') {
        return res.status(403).json({ error: true, message: err.message });
      }
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message });
      }
      res.status(400).json({ error: true, message: err.message });
    }
  });

  /** POST /api/b2b/orders/:id/decline */
  router.post('/orders/:id/decline', (req, res) => {
    try {
      const bizId = getBizId(req);
      const { reason } = req.body;
      const result = service.declineOrCancelTrade(parseInt(req.params.id, 10), bizId, reason);
      res.json(result);
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') {
        return res.status(403).json({ error: true, message: err.message });
      }
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message });
      }
      res.status(400).json({ error: true, message: err.message });
    }
  });

  /** POST /api/b2b/orders/:id/ship */
  router.post('/orders/:id/ship', (req, res) => {
    try {
      const bizId = getBizId(req);
      const result = service.markShipped(parseInt(req.params.id, 10), bizId);
      res.json(result);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message });
      }
      res.status(400).json({ error: true, message: err.message });
    }
  });

  /** POST /api/b2b/orders/:id/receive */
  router.post('/orders/:id/receive', (req, res) => {
    try {
      const bizId = getBizId(req);
      const result = service.receiveTradeIntoStock(parseInt(req.params.id, 10), bizId);
      res.json(result);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message });
      }
      res.status(400).json({ error: true, message: err.message });
    }
  });

  /** GET /api/b2b/profile */
  router.get('/profile', (req, res) => {
    try {
      const bizId = getBizId(req);
      let profile = db.prepare('SELECT * FROM b2b_profiles WHERE business_id = ?').get(bizId);
      if (!profile) {
        const biz = db.prepare('SELECT name FROM businesses WHERE id = ?').get(bizId);
        profile = {
          business_id: bizId,
          public_name: biz ? biz.name : 'My Wholesale Business',
          category: 'General Wholesale',
          city: 'Main Logistics Center',
          gst_or_reg_no: '',
          is_verified: 1,
          min_order_cents: 25000,
          delivery_days: 3,
          is_public: 1,
          description: 'Verified commercial wholesale distributor'
        };
      }

      const products = db.prepare(`
        SELECT 
          p.id, p.sku, p.name, p.category, p.pack_size,
          p.sell_price_cents,
          COALESCE(p.is_b2b_listed, 0) AS is_b2b_listed,
          COALESCE(p.b2b_price_cents, p.sell_price_cents) AS b2b_price_cents,
          COALESCE(p.b2b_moq, p.pack_size, 1) AS b2b_moq,
          COALESCE(sm.on_hand, 0) AS on_hand
        FROM products p
        LEFT JOIN (
          SELECT product_id, SUM(change_qty) AS on_hand
          FROM stock_movements WHERE business_id = ? GROUP BY product_id
        ) sm ON p.id = sm.product_id
        WHERE p.business_id = ? AND p.is_archived = 0
        ORDER BY p.is_b2b_listed DESC, p.name ASC
      `).all(bizId, bizId);

      res.json({ ...profile, products });
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /** POST /api/b2b/profile */
  router.post('/profile', (req, res) => {
    try {
      const bizId = getBizId(req);
      const { public_name, category, city, gst_or_reg_no, min_order_cents, delivery_days, is_public, description, products } = req.body;
      const isPublicFlag = is_public !== undefined ? (is_public ? 1 : 0) : 1;

      const tx = db.transaction(() => {
        db.prepare(`
          INSERT OR REPLACE INTO b2b_profiles (
            business_id, public_name, category, city, gst_or_reg_no, is_verified,
            min_order_cents, delivery_days, is_public, description, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
        `).run(
          bizId,
          public_name || 'My Wholesale Business',
          category || 'General Wholesale',
          city || 'Logistics Hub',
          gst_or_reg_no || '',
          parseInt(min_order_cents || 25000, 10),
          parseInt(delivery_days || 3, 10),
          isPublicFlag,
          description || ''
        );

        if (Array.isArray(products)) {
          const upd = db.prepare(`
            UPDATE products
            SET is_b2b_listed = ?, b2b_price_cents = ?, b2b_moq = ?
            WHERE id = ? AND business_id = ?
          `);
          for (const item of products) {
            const pId = parseInt(item.id, 10);
            if (!pId) continue;
            upd.run(
              item.is_b2b_listed ? 1 : 0,
              item.b2b_price_cents !== undefined && item.b2b_price_cents !== null ? parseInt(item.b2b_price_cents, 10) : null,
              Math.max(1, parseInt(item.b2b_moq || 1, 10)),
              pId,
              bizId
            );
          }
        }

        // Auto-Publish Fallback: if public directory listing is enabled and 0 products are listed,
        // auto-publish active catalog items so the storefront never shows 0 items by accident.
        if (isPublicFlag === 1) {
          const listedRow = db.prepare('SELECT COUNT(*) AS cnt FROM products WHERE business_id = ? AND is_archived = 0 AND is_b2b_listed = 1').get(bizId);
          if (!listedRow || listedRow.cnt === 0) {
            db.prepare(`
              UPDATE products
              SET is_b2b_listed = 1,
                  b2b_price_cents = COALESCE(b2b_price_cents, sell_price_cents),
                  b2b_moq = COALESCE(NULLIF(b2b_moq, 1), pack_size, 1)
              WHERE business_id = ? AND is_archived = 0
            `).run(bizId);
          }
        }
      });

      tx();
      const finalCount = db.prepare('SELECT COUNT(*) AS cnt FROM products WHERE business_id = ? AND is_archived = 0 AND is_b2b_listed = 1').get(bizId)?.cnt || 0;
      res.json({ success: true, listedCount: finalCount, message: `B2B Profile saved (${finalCount} products published)` });
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /** POST /api/b2b/products/:id/listing */
  router.post('/products/:id/listing', (req, res) => {
    try {
      const bizId = getBizId(req);
      const prodId = parseInt(req.params.id, 10);
      const { is_b2b_listed, b2b_price_cents, b2b_moq } = req.body;

      const prod = db.prepare('SELECT id FROM products WHERE id = ? AND business_id = ?').get(prodId, bizId);
      if (!prod) {
        return res.status(404).json({ error: true, message: 'Product not found' });
      }

      db.prepare(`
        UPDATE products
        SET is_b2b_listed = ?, b2b_price_cents = ?, b2b_moq = ?
        WHERE id = ? AND business_id = ?
      `).run(
        is_b2b_listed ? 1 : 0,
        b2b_price_cents ? parseInt(b2b_price_cents, 10) : null,
        b2b_moq ? parseInt(b2b_moq, 10) : 1,
        prodId,
        bizId
      );

      res.json({ success: true, message: 'Product B2B listing updated' });
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  return router;
}

module.exports = createB2bRouter;
