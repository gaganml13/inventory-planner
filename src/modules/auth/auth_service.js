/**
 * auth_service.js — Authentication, Session Lifecycle, and Tenant Isolation
 */

'use strict';

const crypto = require('crypto');

class AuthService {
  constructor(db) {
    this.db = db;
  }

  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }

  verifyPassword(password, stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt, originalHash] = stored.split(':');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'utf8'), Buffer.from(originalHash, 'utf8'));
  }

  createSession(userId, businessId, ttlDays = 7) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

    this.db.prepare(`
      INSERT INTO sessions (id, user_id, business_id, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, userId, businessId, expiresAt);

    return { token, expiresAt };
  }

  validateSession(token) {
    if (!token) return null;

    const row = this.db.prepare(`
      SELECT 
        s.id AS session_id,
        s.expires_at,
        u.id AS user_id,
        u.email,
        u.name AS user_name,
        COALESCE(u.role, 'OWNER') AS role,
        u.is_guest,
        b.id AS business_id,
        b.name AS business_name,
        b.currency,
        b.is_demo,
        b.cash_reserve_cents,
        b.operating_cash_cents,
        COALESCE(b.timezone, 'UTC') AS timezone,
        COALESCE(b.default_lead_days, 7) AS default_lead_days,
        COALESCE(b.default_payment_terms_days, 30) AS default_payment_terms_days,
        COALESCE(b.approval_threshold_cents, 50000) AS approval_threshold_cents,
        COALESCE(b.enable_batch_tracking, 0) AS enable_batch_tracking,
        COALESCE(b.enable_barcode_scanner, 1) AS enable_barcode_scanner
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN businesses b ON b.id = s.business_id
      WHERE s.id = ?
    `).get(token);

    if (!row) return null;

    // Check expiration
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.deleteSession(token);
      return null;
    }

    return {
      sessionId: row.session_id,
      user: {
        id: row.user_id,
        email: row.email,
        name: row.user_name,
        role: row.role || 'OWNER',
        isGuest: Boolean(row.is_guest)
      },
      business: {
        id: row.business_id,
        name: row.business_name,
        currency: row.currency,
        isDemo: Boolean(row.is_demo),
        cashReserveCents: row.cash_reserve_cents,
        operatingCashCents: row.operating_cash_cents,
        timezone: row.timezone,
        defaultLeadDays: row.default_lead_days,
        defaultPaymentTermsDays: row.default_payment_terms_days,
        approvalThresholdCents: row.approval_threshold_cents,
        enableBatchTracking: Boolean(row.enable_batch_tracking),
        enableBarcodeScanner: Boolean(row.enable_barcode_scanner)
      }
    };
  }

  deleteSession(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
  }

  loginUser(email, password) {
    if (!email || !password) {
      throw new Error('Email and password are required');
    }

    const user = this.db.prepare(`
      SELECT id, email, password_hash, name, business_id, is_guest 
      FROM users 
      WHERE email = ? COLLATE NOCASE
    `).get(email.trim());

    if (!user || user.is_guest === 1) {
      throw new Error('Invalid email or password');
    }

    const isValid = this.verifyPassword(password, user.password_hash);
    if (!isValid) {
      throw new Error('Invalid email or password');
    }

    const business = this.db.prepare(`
      SELECT id, name, currency, is_demo, cash_reserve_cents, operating_cash_cents
      FROM businesses
      WHERE id = ?
    `).get(user.business_id);

    const { token, expiresAt } = this.createSession(user.id, business.id);

    return {
      token,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isGuest: false
      },
      business: {
        id: business.id,
        name: business.name,
        currency: business.currency,
        isDemo: Boolean(business.is_demo)
      }
    };
  }

  registerUser(email, password, businessName) {
    if (!email || !password) {
      throw new Error('Email and password are required');
    }
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail.includes('@') || cleanEmail.length < 5) {
      throw new Error('Please enter a valid email address');
    }
    if (password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }

    const existing = this.db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(cleanEmail);
    if (existing) {
      throw new Error('An account with this email already exists');
    }

    const defaultBizName = businessName && businessName.trim() ? businessName.trim() : `${cleanEmail.split('@')[0]} Wholesale`;

    let userRes;
    let bizId;

    const tx = this.db.transaction(() => {
      // Create fresh private business tenant
      const bRes = this.db.prepare(`
        INSERT INTO businesses (name, currency, cash_reserve_cents, operating_cash_cents, slug, is_demo)
        VALUES (?, 'USD', 1000000, 5000000, '', 0)
      `).run(defaultBizName);
      bizId = bRes.lastInsertRowid;

      // Create default primary location
      this.db.prepare(`
        INSERT INTO locations (business_id, name, description)
        VALUES (?, 'Primary Warehouse', 'Default operational depot')
      `).run(bizId);

      // Create user
      const pwHash = this.hashPassword(password);
      userRes = this.db.prepare(`
        INSERT INTO users (email, password_hash, name, business_id, is_guest)
        VALUES (?, ?, ?, ?, 0)
      `).run(cleanEmail, pwHash, defaultBizName, bizId);
    });

    tx();

    const { token, expiresAt } = this.createSession(userRes.lastInsertRowid, bizId);

    return {
      token,
      expiresAt,
      user: {
        id: userRes.lastInsertRowid,
        email: cleanEmail,
        name: defaultBizName,
        isGuest: false
      },
      business: {
        id: bizId,
        name: defaultBizName,
        currency: 'USD',
        isDemo: false
      }
    };
  }

  loginGuest() {
    let demoBiz = this.db.prepare(`
      SELECT id, name, currency, is_demo, cash_reserve_cents, operating_cash_cents 
      FROM businesses 
      WHERE slug = 'demo-vanguard-wholesale' OR slug = 'demo-apex-wholesale' OR is_demo = 1 
      ORDER BY id ASC 
      LIMIT 1
    `).get();

    if (!demoBiz) {
      // Auto-fallback: get first business
      demoBiz = this.db.prepare(`
        SELECT id, name, currency, is_demo, cash_reserve_cents, operating_cash_cents 
        FROM businesses 
        ORDER BY id ASC 
        LIMIT 1
      `).get();
      if (!demoBiz) {
        throw new Error('Demo tenant is not yet initialized. Please seed the database.');
      }
    }

    let guestUser = this.db.prepare(`
      SELECT id, email, name, business_id 
      FROM users 
      WHERE business_id = ? AND is_guest = 1 
      LIMIT 1
    `).get(demoBiz.id);

    if (!guestUser) {
      const uRes = this.db.prepare(`
        INSERT INTO users (email, password_hash, name, business_id, is_guest)
        VALUES (?, 'guest_mode_hash', 'Guest Operator', ?, 1)
      `).run(`guest_${Date.now()}@vanguardwholesale.demo`, demoBiz.id);
      guestUser = {
        id: uRes.lastInsertRowid,
        email: 'guest@vanguardwholesale.demo',
        name: 'Guest Operator',
        business_id: demoBiz.id
      };
    }

    const { token, expiresAt } = this.createSession(guestUser.id, demoBiz.id);

    return {
      token,
      expiresAt,
      user: {
        id: guestUser.id,
        email: guestUser.email,
        name: guestUser.name,
        isGuest: true
      },
      business: {
        id: demoBiz.id,
        name: demoBiz.name,
        currency: demoBiz.currency,
        isDemo: true
      }
    };
  }
}

module.exports = AuthService;
