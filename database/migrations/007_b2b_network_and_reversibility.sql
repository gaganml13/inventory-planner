-- 007_b2b_network_and_reversibility.sql
-- Unified B2B Wholesale Network & Action Reversibility Migration

-- 1. B2B Wholesale Profiles
CREATE TABLE IF NOT EXISTS b2b_profiles (
  business_id     INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  public_name     TEXT    NOT NULL,
  category        TEXT    DEFAULT 'General Wholesale',
  city            TEXT    DEFAULT 'Metro Distribution Hub',
  gst_or_reg_no   TEXT,
  is_verified     INTEGER DEFAULT 1,
  min_order_cents INTEGER DEFAULT 50000,
  delivery_days   INTEGER DEFAULT 3,
  is_public       INTEGER DEFAULT 1,
  description     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 2. Product B2B Listing Fields
-- (Using safe column additions via IF NOT EXISTS pattern)
ALTER TABLE products ADD COLUMN is_b2b_listed INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN b2b_price_cents INTEGER DEFAULT NULL;
ALTER TABLE products ADD COLUMN b2b_moq INTEGER DEFAULT 1;

-- 3. B2B Trade Orders (Linked Buyer PO <-> Seller SO)
CREATE TABLE IF NOT EXISTS b2b_trade_orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_business_id   INTEGER NOT NULL REFERENCES businesses(id),
  seller_business_id  INTEGER NOT NULL REFERENCES businesses(id),
  buyer_po_id         INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  seller_so_id        INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING_APPROVAL', 
  -- PENDING_APPROVAL, ACCEPTED, SHIPPED, COMPLETED, DECLINED, CANCELLED
  total_cents         INTEGER NOT NULL DEFAULT 0,
  trade_notes         TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_b2b_trade_buyer ON b2b_trade_orders(buyer_business_id);
CREATE INDEX IF NOT EXISTS idx_b2b_trade_seller ON b2b_trade_orders(seller_business_id);

-- 4. Payment Allocations Void Flag
ALTER TABLE payment_allocations ADD COLUMN is_voided INTEGER DEFAULT 0;
ALTER TABLE payment_allocations ADD COLUMN void_reason TEXT DEFAULT NULL;
ALTER TABLE payment_allocations ADD COLUMN voided_at TEXT DEFAULT NULL;
