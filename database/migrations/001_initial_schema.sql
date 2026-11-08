-- 001_initial_schema.sql
-- Smart Business Manager for Wholesale Operators
-- Core relational schema with strict integrity, ledgers, foreign keys, and indexes.

PRAGMA foreign_keys = ON;

-- 1. Tenants & Businesses
CREATE TABLE IF NOT EXISTS businesses (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  currency            TEXT    NOT NULL DEFAULT 'USD',
  cash_reserve_cents  INTEGER NOT NULL DEFAULT 5000000, -- Default $50,000 reserve
  operating_cash_cents INTEGER NOT NULL DEFAULT 15000000, -- Default $150,000 operating capital
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 2. Physical Locations
CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  description TEXT    DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 3. Commercial Contacts (Customers & Suppliers)
CREATE TABLE IF NOT EXISTS contacts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id        INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type               TEXT    NOT NULL CHECK(type IN ('CUSTOMER', 'SUPPLIER')),
  name               TEXT    NOT NULL,
  email              TEXT    DEFAULT '',
  phone              TEXT    DEFAULT '',
  credit_limit_cents INTEGER NOT NULL DEFAULT 0 CHECK(credit_limit_cents >= 0),
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK(payment_terms_days >= 0),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 4. Catalog Products with Wholesale Logistics Parameters
CREATE TABLE IF NOT EXISTS products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id       INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sku               TEXT    NOT NULL COLLATE NOCASE,
  barcode           TEXT    NOT NULL COLLATE NOCASE,
  name              TEXT    NOT NULL,
  category          TEXT    NOT NULL DEFAULT 'General',
  base_unit         TEXT    NOT NULL DEFAULT 'pcs',
  pack_size         INTEGER NOT NULL DEFAULT 1 CHECK(pack_size >= 1),
  lead_days         INTEGER NOT NULL DEFAULT 7 CHECK(lead_days >= 1),
  min_safety_stock  INTEGER NOT NULL DEFAULT 0 CHECK(min_safety_stock >= 0),
  cost_price_cents  INTEGER NOT NULL DEFAULT 0 CHECK(cost_price_cents >= 0),
  sell_price_cents  INTEGER NOT NULL DEFAULT 0 CHECK(sell_price_cents >= 0),
  source_tag        TEXT    NOT NULL DEFAULT 'SYNTHETIC', -- 'UCI_RETAIL' or 'SYNTHETIC'
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT uq_product_sku UNIQUE (business_id, sku),
  CONSTRAINT uq_product_barcode UNIQUE (business_id, barcode)
);

-- 5. Commercial Orders (Sales, Purchases, Returns)
CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  order_number    TEXT    NOT NULL COLLATE NOCASE,
  type            TEXT    NOT NULL CHECK(type IN ('SALE', 'PURCHASE', 'RETURN')),
  status          TEXT    NOT NULL CHECK(status IN ('DRAFT', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED')) DEFAULT 'DRAFT',
  order_date      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  due_date        TEXT    NOT NULL,
  total_cents     INTEGER NOT NULL DEFAULT 0 CHECK(total_cents >= 0),
  paid_cents      INTEGER NOT NULL DEFAULT 0 CHECK(paid_cents >= 0),
  notes           TEXT    DEFAULT '',
  allow_backorder INTEGER NOT NULL DEFAULT 0 CHECK(allow_backorder IN (0, 1)),
  source_tag      TEXT    NOT NULL DEFAULT 'SYNTHETIC',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT uq_order_number UNIQUE (business_id, order_number)
);

-- 6. Order Line Items with Wholesale Pack Multipliers
CREATE TABLE IF NOT EXISTS order_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity         INTEGER NOT NULL CHECK(quantity > 0),
  pack_quantity    INTEGER NOT NULL DEFAULT 1 CHECK(pack_quantity >= 1),
  unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
  tax_cents        INTEGER NOT NULL DEFAULT 0 CHECK(tax_cents >= 0),
  discount_cents   INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents >= 0),
  total_cents      INTEGER NOT NULL CHECK(total_cents >= 0)
);

-- 7. Immutable Stock Movements Ledger
CREATE TABLE IF NOT EXISTS stock_movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id   INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  change_qty    INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason        TEXT    NOT NULL,
  order_line_id INTEGER REFERENCES order_lines(id) ON DELETE SET NULL,
  source_tag    TEXT    NOT NULL DEFAULT 'SYNTHETIC',
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 8. Payment Allocations Ledger
CREATE TABLE IF NOT EXISTS payment_allocations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_cents   INTEGER NOT NULL CHECK(amount_cents > 0),
  payment_method TEXT    NOT NULL DEFAULT 'BANK_TRANSFER',
  notes          TEXT    DEFAULT '',
  recorded_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 9. Demand Forecasts Generated by ML & Baselines
CREATE TABLE IF NOT EXISTS demand_forecasts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id       INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  horizon_days      INTEGER NOT NULL CHECK(horizon_days > 0),
  p50_qty           REAL    NOT NULL CHECK(p50_qty >= 0),
  p90_qty           REAL    NOT NULL CHECK(p90_qty >= 0),
  model_name        TEXT    NOT NULL,
  uncertainty_score REAL    NOT NULL CHECK(uncertainty_score >= 0.0),
  generated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 10. Purchase Recommendations Prioritized by Working Capital
CREATE TABLE IF NOT EXISTS purchase_recommendations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  recommended_qty INTEGER NOT NULL CHECK(recommended_qty >= 0),
  cost_cents      INTEGER NOT NULL CHECK(cost_cents >= 0),
  priority_rank   INTEGER NOT NULL,
  rationale_json  TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'ORDERED')) DEFAULT 'PENDING',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 11. Data Import Line Hashes for Idempotent Ingestion
CREATE TABLE IF NOT EXISTS data_import_hashes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  import_type     TEXT    NOT NULL, -- 'PRODUCTS', 'ORDERS', 'STOCK'
  line_hash       TEXT    NOT NULL,
  source_tag      TEXT    NOT NULL DEFAULT 'SYNTHETIC',
  record_metadata TEXT    DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT uq_import_hash UNIQUE (business_id, line_hash)
);

-- 12. Performance & Look-Up Indices
CREATE INDEX IF NOT EXISTS idx_orders_business_date ON orders(business_id, order_date);
CREATE INDEX IF NOT EXISTS idx_orders_due_date ON orders(due_date);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_contact ON orders(contact_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_product ON order_lines(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_prod_loc ON stock_movements(product_id, location_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_contacts_lookup ON contacts(business_id, type, name);
CREATE INDEX IF NOT EXISTS idx_payment_order ON payment_allocations(order_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_forecasts_prod ON demand_forecasts(product_id, generated_at);
CREATE INDEX IF NOT EXISTS idx_recommendations_prod ON purchase_recommendations(product_id, status);
CREATE INDEX IF NOT EXISTS idx_import_hashes_lookup ON data_import_hashes(business_id, line_hash);
