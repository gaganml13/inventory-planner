/**
 * app.js — Central Express Application Configuration
 *
 * Implements:
 * - Cookie-based and Bearer-based Authentication & Session Management
 * - Dual-Mode Tenant Isolation (Guest Demo vs Private Tenant)
 * - Operational Workspace API Routers:
 *   - /api/auth
 *   - /api/inventory
 *   - /api/orders
 *   - /api/payments
 *   - /api/contacts
 *   - /api/data
 *   - /api/intelligence
 * - Legacy compatibility endpoints
 * - Static UI dashboard serving with login gate
 */

'use strict';

const express = require('express');
const path = require('path');
const { getDb } = require('../database/connection');
const { runMigrations } = require('../database/migrator');

const AuthService = require('./modules/auth/auth_service');
const { createAuthMiddleware } = require('./modules/auth/middleware');
const createAuthRouter = require('./modules/auth/routes');

const createInventoryRouter = require('./modules/inventory/routes');
const createOrderRouter = require('./modules/orders/routes');
const createPaymentRouter = require('./modules/payments/routes');
const createContactRouter = require('./modules/contacts/routes');
const createDataRouter = require('./modules/data/routes');
const createIntelligenceRouter = require('./modules/intelligence/routes');
const createAssistantRouter = require('./modules/assistant/routes');

const InventoryService = require('./modules/inventory/inventory_service');
const PaymentService = require('./modules/payments/payment_service');
const ReorderEngine = require('./modules/intelligence/reorder_engine');

function createApp(customDb) {
  const db = customDb || getDb();
  runMigrations(db);

  const authService = new AuthService(db);
  const { authenticate, requireAuth } = createAuthMiddleware(authService);
  const invService = new InventoryService(db);
  const payService = new PaymentService(db);
  const reorderEngine = new ReorderEngine(db);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Global Session Authentication (populates req.user & req.business if session exists)
  app.use(authenticate);

  // Authentication Router (Public & Session routes)
  const authRouter = createAuthRouter(authService, db);
  app.use('/api/auth', authRouter);

  // Settings & Profile Top-Level Aliases
  app.get('/api/settings', requireAuth, (req, res, next) => {
    req.url = '/settings';
    authRouter(req, res, next);
  });
  app.put('/api/settings', requireAuth, (req, res, next) => {
    req.url = '/settings';
    authRouter(req, res, next);
  });
  app.post('/api/settings', requireAuth, (req, res, next) => {
    req.url = '/settings';
    authRouter(req, res, next);
  });
  app.get('/api/profile', requireAuth, (req, res, next) => {
    req.url = '/profile';
    authRouter(req, res, next);
  });
  app.put('/api/profile', requireAuth, (req, res, next) => {
    req.url = '/profile';
    authRouter(req, res, next);
  });

  // Serve static assets (CSS, JS, images)
  const staticPath = path.join(__dirname, 'public');
  app.use(express.static(staticPath));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Login view route (public)
  app.get('/login', (_req, res) => {
    res.sendFile(path.join(staticPath, 'login.html'));
  });

  // Protected API routes
  app.use('/api/inventory', requireAuth, createInventoryRouter(db));
  app.use('/api/orders', requireAuth, createOrderRouter(db));
  app.use('/api/payments', requireAuth, createPaymentRouter(db));
  app.use('/api/contacts', requireAuth, createContactRouter(db));
  app.use('/api/data', requireAuth, createDataRouter(db));
  app.use('/api/intelligence', requireAuth, createIntelligenceRouter(db));
  app.use('/api/assistant', requireAuth, createAssistantRouter(db));

  // Legacy & Overview Helper APIs
  const getBizId = (req) => {
    if (req.user && req.user.businessId) return req.user.businessId;
    return parseInt(req.query.business_id || req.body?.business_id || 1, 10);
  };

  /** Metrics & Overview handler with Self-Seed Demo Tenant on Fresh Load */
  const metricsHandler = (req, res) => {
    try {
      const bizId = getBizId(req);
      let positions = invService.getStockPositions(bizId);

      // Self-Seed Demo Tenant on Fresh Load if 0 products or $0.00 valuation
      const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(bizId);
      const isDemo = biz && (biz.is_demo || biz.slug === 'demo-vanguard-wholesale' || biz.slug === 'demo-apex-wholesale' || biz.name.includes('Vanguard Wholesale') || biz.name.includes('Apex Wholesale') || req.user?.isGuest);
      let valuation = positions.reduce((acc, p) => acc + (Math.max(0, p.on_hand) * (p.cost_price_cents || 0)), 0);

      if (isDemo && (positions.length === 0 || valuation === 0)) {
        try {
          const { seedDatabase } = require('../database/seed');
          seedDatabase(db);
          positions = invService.getStockPositions(bizId);
          valuation = positions.reduce((acc, p) => acc + (Math.max(0, p.on_hand) * (p.cost_price_cents || 0)), 0);
          reorderEngine.computeRecommendations(bizId);
        } catch (e) {
          console.warn('Auto-seed demo notice:', e.message);
        }
      }

      const fin = payService.getFinancialSummary(bizId);
      let recs = reorderEngine.getStoredRecommendations(bizId);
      if (recs.length === 0 && positions.length > 0) {
        try {
          reorderEngine.computeRecommendations(bizId);
          recs = reorderEngine.getStoredRecommendations(bizId);
        } catch (_) {}
      }

      const totalItems = positions.length;
      const activeSkus = positions.filter((p) => p.on_hand > 0).length;
      const lowStock = positions.filter((p) => p.on_hand <= p.min_safety_stock).length;
      const inventoryAssetValueCents = positions.reduce((acc, p) => acc + (Math.max(0, p.on_hand) * (p.cost_price_cents || 0)), 0);

      let stockoutRiskCount = 0;
      let criticalPoCostCents = 0;

      for (const r of recs) {
        const coverDays = r.evidence?.why?.current_cover_days ?? 999;
        const leadDays = r.lead_days || 7;
        const isCritical = (coverDays < leadDays) || (r.priority_rank <= 3 && r.recommended_qty > 0);
        if (isCritical) {
          stockoutRiskCount++;
          criticalPoCostCents += (r.cost_cents || 0);
        }
      }

      // Top 5 urgent reorder priorities for the horizontal bar chart
      const topReorderPriorities = recs.slice(0, 5).map((r) => {
        const why = r.evidence?.why || {};
        const leadDemand = why.lead_demand_forecast || 0;
        const safetyStock = why.safety_stock_units || 0;
        const currentStock = why.available_stock !== undefined ? why.available_stock : (r.on_hand || 0);
        const reorderPoint = leadDemand + safetyStock;
        return {
          sku: r.sku,
          name: r.product_name || r.name,
          currentStock,
          reorderPoint,
          recommendedQty: r.recommended_qty,
          coverDays: why.current_cover_days || 0
        };
      });

      // Generate Action-Oriented "Today's Actions" Checklist
      const todaysActions = [];

      // 1. Critical Reorder Actions
      const criticalRecs = recs.filter((r) => r.status === 'PENDING' && (r.priority_rank <= 3 || (r.evidence?.why?.current_cover_days ?? 999) < (r.lead_days || 7)));
      for (const cr of criticalRecs.slice(0, 3)) {
        todaysActions.push({
          id: `reorder-${cr.id}`,
          type: 'REORDER_CRITICAL',
          category: 'Purchasing',
          urgency: 'HIGH',
          title: `Approve restock for ${cr.sku} (${cr.recommended_qty} units)`,
          description: `Stock cover is down to ${cr.evidence?.why?.current_cover_days ?? 0}d (lead time: ${cr.lead_days || 7}d). Estimated cost: $${((cr.cost_cents || 0) / 100).toFixed(2)}.`,
          actionLabel: 'Generate Draft PO',
          actionHandler: 'openDrawer',
          payload: { recommendationId: cr.id }
        });
      }

      // 2. Overdue Receivable Collection Actions
      const overdueSales = db.prepare(`
        SELECT o.id, o.order_number, o.due_date, (o.total_cents - o.paid_cents) AS balance_cents, c.name AS customer_name
        FROM orders o
        JOIN contacts c ON o.contact_id = c.id
        WHERE o.business_id = ? AND o.type = 'SALE' AND o.status != 'CANCELLED' AND o.paid_cents < o.total_cents
          AND date(o.due_date) < date('now')
        ORDER BY balance_cents DESC LIMIT 2
      `).all(bizId);

      for (const os of overdueSales) {
        todaysActions.push({
          id: `collect-${os.id}`,
          type: 'COLLECT_PAYMENT',
          category: 'Receivables',
          urgency: 'MEDIUM',
          title: `Follow up on overdue invoice #${os.order_number} (${os.customer_name})`,
          description: `Unpaid balance: $${(os.balance_cents / 100).toFixed(2)}. Due date was ${os.due_date}.`,
          actionLabel: 'Record Payment',
          actionHandler: 'openPayment',
          payload: { orderId: os.id }
        });
      }

      // 3. Pending Cycle Count Review Actions
      const pendingCounts = db.prepare(`
        SELECT id, count_number, (SELECT COUNT(*) FROM cycle_count_items WHERE cycle_count_id = cycle_counts.id) AS item_count
        FROM cycle_counts
        WHERE business_id = ? AND status = 'PENDING_APPROVAL'
        LIMIT 2
      `).all(bizId);

      for (const pc of pendingCounts) {
        todaysActions.push({
          id: `count-${pc.id}`,
          type: 'CYCLE_COUNT_REVIEW',
          category: 'Warehouse Audit',
          urgency: 'MEDIUM',
          title: `Review physical audit discrepancy for ${pc.count_number}`,
          description: `${pc.item_count} items counted and awaiting manager approval for inventory balance reconciliation.`,
          actionLabel: 'Review Audit',
          actionHandler: 'reviewCount',
          payload: { countId: pc.id }
        });
      }

      res.json({
        totalItems,
        activeSkus,
        lowStock,
        inventoryAssetValueCents,
        topReorderPriorities,
        todaysActions,
        purchasingBudgetCents: fin.purchasingBudgetCents,
        workingCapitalAvailableCents: fin.workingCapitalAvailableCents,
        upcomingAp14dCents: fin.upcomingAp14dCents,
        stockoutRiskCount,
        criticalPoCommitmentCents: criticalPoCostCents,
        totalArCents: fin.accountsReceivable.totalCents,
        overdueArCents: fin.accountsReceivable.overdueCents,
        totalApCents: fin.accountsPayable.totalCents,
        freeWorkingCapitalCents: fin.freeWorkingCapitalCents,
        cashReserveCents: fin.cashReserveCents,
        operatingCashCents: fin.operatingCashCents
      });
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  };

  /** GET /api/metrics & GET /api/overview */
  app.get('/api/metrics', requireAuth, metricsHandler);
  app.get('/api/overview', requireAuth, metricsHandler);

  /** GET /api/products (alias to positions list) */
  app.get('/api/products', requireAuth, (req, res) => {
    try {
      const bizId = getBizId(req);
      res.json(invService.getStockPositions(bizId));
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /** GET /api/items (legacy backward compatibility) */
  app.get('/api/items', requireAuth, (req, res) => {
    try {
      const bizId = getBizId(req);
      let items = invService.getStockPositions(bizId);

      if (req.query.search) {
        const q = String(req.query.search).toLowerCase();
        items = items.filter((i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q));
      }
      if (req.query.category) {
        items = items.filter((i) => i.category === req.query.category);
      }

      res.json(items.map((i) => ({
        id: i.product_id,
        sku: i.sku,
        name: i.name,
        category: i.category,
        quantity: i.on_hand,
        min_threshold: i.min_safety_stock,
        unit: i.base_unit,
        available: i.available,
        reserved: i.reserved,
        incoming_po: i.incoming_po,
        cost_price_cents: i.cost_price_cents,
        sell_price_cents: i.sell_price_cents
      })));
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /** GET /api/alerts/low-stock (legacy backward compatibility) */
  app.get('/api/alerts/low-stock', requireAuth, (req, res) => {
    try {
      const bizId = getBizId(req);
      const positions = invService.getStockPositions(bizId);
      const low = positions
        .filter((p) => p.on_hand <= p.min_safety_stock)
        .sort((a, b) => (a.on_hand - a.min_safety_stock) - (b.on_hand - b.min_safety_stock));

      res.json(low.map((i) => ({
        id: i.product_id,
        sku: i.sku,
        name: i.name,
        quantity: i.on_hand,
        min_threshold: i.min_safety_stock,
        unit: i.base_unit
      })));
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /** GET /api/transactions (legacy backward compatibility) */
  app.get('/api/transactions', requireAuth, (req, res) => {
    try {
      const bizId = getBizId(req);
      const movements = invService.getMovements({ businessId: bizId, limit: req.query.limit || 50 });
      res.json(movements.map((m) => ({
        id: m.id,
        sku: m.sku,
        item_name: m.product_name,
        change_type: m.change_qty > 0 ? 'IN' : 'OUT',
        quantity: Math.abs(m.change_qty),
        notes: m.reason,
        created_at: m.created_at
      })));
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /** GET /api/locations */
  app.get('/api/locations', requireAuth, (req, res) => {
    try {
      const bizId = getBizId(req);
      res.json(invService.getLocations(bizId));
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  // Client SPA Route: Redirect unauthenticated requests to /login
  app.get('*', (req, res) => {
    if (!req.user) {
      return res.redirect('/login');
    }
    res.sendFile(path.join(staticPath, 'index.html'));
  });

  return app;
}

module.exports = { createApp };
