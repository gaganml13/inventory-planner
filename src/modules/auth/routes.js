/**
 * routes.js — Authentication Endpoints
 */

'use strict';

const express = require('express');

function createAuthRouter(authService, db) {
  const router = express.Router();

  function setSessionCookie(res, token) {
    // 7 days in seconds
    const maxAge = 7 * 24 * 60 * 60;
    res.setHeader(
      'Set-Cookie',
      `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    );
  }

  function clearSessionCookie(res) {
    res.setHeader(
      'Set-Cookie',
      'session=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    );
  }

  router.post('/login', (req, res) => {
    try {
      const { email, password } = req.body;
      const result = authService.loginUser(email, password);
      setSessionCookie(res, result.token);
      res.json({
        success: true,
        user: result.user,
        business: result.business
      });
    } catch (err) {
      res.status(401).json({ error: true, message: err.message });
    }
  });

  router.post('/register', (req, res) => {
    try {
      const { email, password, businessName } = req.body;
      const result = authService.registerUser(email, password, businessName);
      setSessionCookie(res, result.token);
      res.json({
        success: true,
        user: result.user,
        business: result.business
      });
    } catch (err) {
      res.status(400).json({ error: true, message: err.message });
    }
  });

  router.post('/guest', (_req, res) => {
    try {
      const result = authService.loginGuest();
      setSessionCookie(res, result.token);
      res.json({
        success: true,
        user: result.user,
        business: result.business
      });
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  router.post('/logout', (req, res) => {
    try {
      if (req.sessionId) {
        authService.deleteSession(req.sessionId);
      }
      clearSessionCookie(res);
      res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
      clearSessionCookie(res);
      res.json({ success: true });
    }
  });

  router.get('/me', (req, res) => {
    if (!req.user || !req.business) {
      return res.json({ authenticated: false });
    }

    // Refresh business details from DB
    const biz = db.prepare(`
      SELECT 
        id, name, currency, is_demo, cash_reserve_cents, operating_cash_cents,
        COALESCE(timezone, 'UTC') AS timezone,
        COALESCE(default_lead_days, 7) AS default_lead_days,
        COALESCE(default_payment_terms_days, 30) AS default_payment_terms_days,
        COALESCE(approval_threshold_cents, 50000) AS approval_threshold_cents,
        COALESCE(enable_batch_tracking, 0) AS enable_batch_tracking,
        COALESCE(enable_barcode_scanner, 1) AS enable_barcode_scanner
      FROM businesses
      WHERE id = ?
    `).get(req.business.id);

    // Check count of products for onboarding checklist
    const prodCountRow = db.prepare(`
      SELECT COUNT(*) AS cnt FROM products WHERE business_id = ?
    `).get(req.business.id);

    res.json({
      authenticated: true,
      user: req.user,
      business: {
        id: biz.id,
        name: biz.name,
        currency: biz.currency,
        isDemo: Boolean(biz.is_demo),
        cashReserveCents: biz.cash_reserve_cents,
        operatingCashCents: biz.operating_cash_cents,
        timezone: biz.timezone,
        defaultLeadDays: biz.default_lead_days,
        defaultPaymentTermsDays: biz.default_payment_terms_days,
        approvalThresholdCents: biz.approval_threshold_cents,
        enableBatchTracking: Boolean(biz.enable_batch_tracking),
        enableBarcodeScanner: Boolean(biz.enable_barcode_scanner),
        productCount: prodCountRow ? prodCountRow.cnt : 0
      }
    });
  });

  // ──────────────────────────────────────────
  // Personal Account Profile Management
  // ──────────────────────────────────────────
  router.get('/profile', (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: true, message: 'Unauthorized' });
    }
    const user = db.prepare(`
      SELECT id, email, name, role, is_guest, business_id, is_active, created_at
      FROM users WHERE id = ?
    `).get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: true, message: 'User not found' });
    }
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name || user.email.split('@')[0],
        role: user.role || 'OWNER',
        isGuest: Boolean(user.is_guest),
        businessId: user.business_id,
        isActive: Boolean(user.is_active),
        createdAt: user.created_at
      }
    });
  });

  router.put('/profile', (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: true, message: 'Unauthorized' });
    }
    if (req.user.isGuest) {
      return res.status(403).json({ error: true, message: 'Demo guest profiles cannot be permanently modified' });
    }

    const { name, email, password } = req.body;
    const cleanEmail = email ? email.trim().toLowerCase() : null;

    if (cleanEmail && cleanEmail !== req.user.email.toLowerCase()) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(cleanEmail, req.user.id);
      if (existing) {
        return res.status(409).json({ error: true, message: 'Email address already in use by another account' });
      }
    }

    const pwHash = password && password.trim().length >= 4 ? authService.hashPassword(password.trim()) : null;

    db.prepare(`
      UPDATE users
      SET name = COALESCE(?, name),
          email = COALESCE(?, email),
          password_hash = COALESCE(?, password_hash)
      WHERE id = ?
    `).run(
      name ? name.trim() : null,
      cleanEmail || null,
      pwHash || null,
      req.user.id
    );

    const updated = db.prepare('SELECT id, email, name, role, is_guest, business_id FROM users WHERE id = ?').get(req.user.id);
    res.json({
      success: true,
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        isGuest: Boolean(updated.is_guest),
        businessId: updated.business_id
      }
    });
  });

  // Comprehensive Business Settings
  const getSettingsHandler = (req, res) => {
    if (!req.business) {
      return res.status(401).json({ error: true, message: 'Unauthorized' });
    }
    const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.business.id);
    if (!biz) {
      return res.status(404).json({ error: true, message: 'Business not found' });
    }
    const settingsObj = {
      id: biz.id,
      name: biz.name,
      business_name: biz.name,
      currency: biz.currency || 'USD',
      timezone: biz.timezone || 'UTC',
      cashReserveCents: biz.cash_reserve_cents,
      operatingCashCents: biz.operating_cash_cents,
      cash_reserve_cents: biz.cash_reserve_cents,
      operating_cash_cents: biz.operating_cash_cents,
      defaultLeadDays: biz.default_lead_days || 7,
      default_lead_days: biz.default_lead_days || 7,
      defaultPaymentTermsDays: biz.default_payment_terms_days || 30,
      default_payment_terms_days: biz.default_payment_terms_days || 30,
      approvalThresholdCents: biz.approval_threshold_cents || 50000,
      approval_threshold_cents: biz.approval_threshold_cents || 50000,
      enableBatchTracking: Boolean(biz.enable_batch_tracking),
      enableBarcodeScanner: Boolean(biz.enable_barcode_scanner)
    };
    res.json({
      success: true,
      settings: settingsObj,
      ...settingsObj
    });
  };

  const updateSettingsHandler = (req, res) => {
    if (!req.business) {
      return res.status(401).json({ error: true, message: 'Unauthorized' });
    }
    if (req.user?.role && req.user.role !== 'OWNER') {
      return res.status(403).json({ error: true, message: 'Only account Owners can update business settings' });
    }

    const {
      name,
      business_name,
      currency,
      timezone,
      defaultLeadDays,
      default_lead_days,
      supplier_lead_days,
      defaultPaymentTermsDays,
      default_payment_terms_days,
      payment_terms_days,
      approvalThresholdCents,
      approval_threshold_cents,
      approval_limit_dollars,
      cashReserveCents,
      cash_reserve_cents,
      min_cash_reserve_dollars,
      operatingCashCents,
      operating_cash_cents,
      cash_available_dollars,
      enableBatchTracking,
      enableBarcodeScanner,
      confirm_currency_change
    } = req.body;

    const currentBiz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.business.id);

    // Prevent accidental currency changes silently relabelling historical data
    const newCurrency = currency ? currency.trim().toUpperCase() : null;
    if (newCurrency && currentBiz.currency && newCurrency !== currentBiz.currency) {
      const txCount = db.prepare('SELECT COUNT(*) AS cnt FROM orders WHERE business_id = ?').get(req.business.id)?.cnt || 0;
      if (txCount > 0 && !confirm_currency_change) {
        return res.status(400).json({
          error: true,
          code: 'CURRENCY_CHANGE_CONFIRMATION_REQUIRED',
          message: `Changing currency from ${currentBiz.currency} to ${newCurrency} will relabel all historical transactions and balance sheets without mathematical FX conversion. To proceed, confirm with confirm_currency_change: true.`
        });
      }
    }

    const finalName = name || business_name || null;
    const finalLead = defaultLeadDays !== undefined ? defaultLeadDays : (default_lead_days !== undefined ? default_lead_days : supplier_lead_days);
    const finalTerms = defaultPaymentTermsDays !== undefined ? defaultPaymentTermsDays : (default_payment_terms_days !== undefined ? default_payment_terms_days : payment_terms_days);

    let finalApprovalCents = approvalThresholdCents !== undefined ? approvalThresholdCents : approval_threshold_cents;
    if (finalApprovalCents === undefined && approval_limit_dollars !== undefined) {
      finalApprovalCents = Math.round(parseFloat(approval_limit_dollars) * 100);
    }

    let finalReserveCents = cashReserveCents !== undefined ? cashReserveCents : cash_reserve_cents;
    if (finalReserveCents === undefined && min_cash_reserve_dollars !== undefined) {
      finalReserveCents = Math.round(parseFloat(min_cash_reserve_dollars) * 100);
    }

    let finalOpCashCents = operatingCashCents !== undefined ? operatingCashCents : operating_cash_cents;
    if (finalOpCashCents === undefined && cash_available_dollars !== undefined) {
      finalOpCashCents = Math.round(parseFloat(cash_available_dollars) * 100);
    }

    db.prepare(`
      UPDATE businesses 
      SET name = COALESCE(?, name),
          currency = COALESCE(?, currency),
          timezone = COALESCE(?, timezone),
          default_lead_days = COALESCE(?, default_lead_days),
          default_payment_terms_days = COALESCE(?, default_payment_terms_days),
          approval_threshold_cents = COALESCE(?, approval_threshold_cents),
          cash_reserve_cents = COALESCE(?, cash_reserve_cents),
          operating_cash_cents = COALESCE(?, operating_cash_cents),
          enable_batch_tracking = COALESCE(?, enable_batch_tracking),
          enable_barcode_scanner = COALESCE(?, enable_barcode_scanner)
      WHERE id = ?
    `).run(
      finalName,
      newCurrency,
      timezone || null,
      finalLead !== undefined ? parseInt(finalLead, 10) : null,
      finalTerms !== undefined ? parseInt(finalTerms, 10) : null,
      finalApprovalCents !== undefined ? parseInt(finalApprovalCents, 10) : null,
      finalReserveCents !== undefined ? parseInt(finalReserveCents, 10) : null,
      finalOpCashCents !== undefined ? parseInt(finalOpCashCents, 10) : null,
      enableBatchTracking !== undefined ? (enableBatchTracking ? 1 : 0) : null,
      enableBarcodeScanner !== undefined ? (enableBarcodeScanner ? 1 : 0) : null,
      req.business.id
    );

    const updated = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.business.id);
    const settingsObj = {
      id: updated.id,
      name: updated.name,
      business_name: updated.name,
      currency: updated.currency || 'USD',
      timezone: updated.timezone || 'UTC',
      cashReserveCents: updated.cash_reserve_cents,
      operatingCashCents: updated.operating_cash_cents,
      cash_reserve_cents: updated.cash_reserve_cents,
      operating_cash_cents: updated.operating_cash_cents,
      defaultLeadDays: updated.default_lead_days,
      default_lead_days: updated.default_lead_days,
      defaultPaymentTermsDays: updated.default_payment_terms_days,
      default_payment_terms_days: updated.default_payment_terms_days,
      approvalThresholdCents: updated.approval_threshold_cents,
      approval_threshold_cents: updated.approval_threshold_cents,
      enableBatchTracking: Boolean(updated.enable_batch_tracking),
      enableBarcodeScanner: Boolean(updated.enable_barcode_scanner)
    };
    res.json({ success: true, settings: settingsObj, business: updated });
  };

  router.get('/settings', getSettingsHandler);
  router.put('/settings', updateSettingsHandler);
  router.post('/settings', updateSettingsHandler);

  // Team Users & Role Management
  router.get('/users', (req, res) => {
    if (!req.business) {
      return res.status(401).json({ error: true, message: 'Unauthorized' });
    }
    const users = db.prepare(`
      SELECT id, email, name, COALESCE(role, 'OWNER') AS role, is_guest, COALESCE(is_active, 1) AS is_active, created_at
      FROM users
      WHERE business_id = ?
      ORDER BY id ASC
    `).all(req.business.id);
    res.json(users);
  });

  router.post('/users', (req, res) => {
    if (!req.business) {
      return res.status(401).json({ error: true, message: 'Unauthorized' });
    }
    if (req.user?.role !== 'OWNER') {
      return res.status(403).json({ error: true, message: 'Only account Owners can add team members' });
    }

    const { email, password, name, role = 'PURCHASING' } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: true, message: 'Email and password are required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(cleanEmail);
    if (existing) {
      return res.status(409).json({ error: true, message: 'User with this email already exists' });
    }

    const validRole = ['OWNER', 'PURCHASING', 'WAREHOUSE'].includes(role) ? role : 'PURCHASING';
    const pwHash = authService.hashPassword(password);
    const uRes = db.prepare(`
      INSERT INTO users (email, password_hash, name, business_id, role, is_guest, is_active)
      VALUES (?, ?, ?, ?, ?, 0, 1)
    `).run(cleanEmail, pwHash, name || cleanEmail.split('@')[0], req.business.id, validRole);

    res.status(201).json({
      success: true,
      userId: uRes.lastInsertRowid,
      email: cleanEmail,
      name: name || cleanEmail.split('@')[0],
      role: validRole,
      is_active: 1
    });
  });

  router.put('/users/:id/role', (req, res) => {
    if (!req.business) {
      return res.status(401).json({ error: true, message: 'Unauthorized' });
    }
    if (req.user?.role !== 'OWNER') {
      return res.status(403).json({ error: true, message: 'Only account Owners can change user roles' });
    }

    const userId = parseInt(req.params.id, 10);
    const { role } = req.body;
    if (!['OWNER', 'PURCHASING', 'WAREHOUSE'].includes(role)) {
      return res.status(400).json({ error: true, message: "Role must be 'OWNER', 'PURCHASING', or 'WAREHOUSE'" });
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ? AND business_id = ?').run(role, userId, req.business.id);
    res.json({ success: true, userId, role });
  });

  router.put('/users/:id/status', (req, res) => {
    if (!req.business) {
      return res.status(401).json({ error: true, message: 'Unauthorized' });
    }
    if (req.user?.role !== 'OWNER') {
      return res.status(403).json({ error: true, message: 'Only account Owners can activate or deactivate team members' });
    }

    const userId = parseInt(req.params.id, 10);
    const { isActive, is_active } = req.body;
    const finalActive = isActive !== undefined ? (isActive ? 1 : 0) : (is_active !== undefined ? (is_active ? 1 : 0) : 0);

    // Prevent sole owner from deactivating themselves
    if (userId === req.user.id && finalActive === 0) {
      return res.status(400).json({ error: true, message: 'You cannot deactivate your own account as an active Owner' });
    }

    db.prepare('UPDATE users SET is_active = ? WHERE id = ? AND business_id = ?').run(finalActive, userId, req.business.id);
    res.json({ success: true, userId, isActive: Boolean(finalActive) });
  });

  // Onboarding endpoint to set working capital limit
  router.post('/settings/capital', (req, res) => {
    if (!req.business) {
      return res.status(401).json({ error: true, message: 'Unauthorized' });
    }
    const { cashReserveCents, operatingCashCents } = req.body;
    db.prepare(`
      UPDATE businesses 
      SET cash_reserve_cents = COALESCE(?, cash_reserve_cents),
          operating_cash_cents = COALESCE(?, operating_cash_cents)
      WHERE id = ?
    `).run(
      cashReserveCents !== undefined ? parseInt(cashReserveCents, 10) : null,
      operatingCashCents !== undefined ? parseInt(operatingCashCents, 10) : null,
      req.business.id
    );

    res.json({ success: true });
  });

  return router;
}

module.exports = createAuthRouter;
