-- 004_operational_features_and_audit.sql
-- Operational Features: RBAC, Cycle Counts, Partial Order Line Fulfillment,
-- Damaged/In-Transit Stock, Product Archival & Configurable Settings

PRAGMA foreign_keys = ON;

-- 1. Extend Users with Role-Based Access Control (RBAC)
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'OWNER' CHECK(role IN ('OWNER', 'PURCHASING', 'WAREHOUSE'));

-- 2. Extend Businesses with Operational Settings
ALTER TABLE businesses ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE businesses ADD COLUMN default_lead_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE businesses ADD COLUMN default_payment_terms_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE businesses ADD COLUMN approval_threshold_cents INTEGER NOT NULL DEFAULT 50000; -- $500 threshold requiring OWNER approval
ALTER TABLE businesses ADD COLUMN enable_batch_tracking INTEGER NOT NULL DEFAULT 0;
ALTER TABLE businesses ADD COLUMN enable_barcode_scanner INTEGER NOT NULL DEFAULT 1;

-- 3. Extend Products with Archival Flag
ALTER TABLE products ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0, 1));
ALTER TABLE products ADD COLUMN min_order_qty INTEGER NOT NULL DEFAULT 1 CHECK(min_order_qty >= 1);

-- 4. Extend Order Lines with Partial Receiving / Partial Fulfillment Tracking
ALTER TABLE order_lines ADD COLUMN fulfilled_quantity INTEGER NOT NULL DEFAULT 0 CHECK(fulfilled_quantity >= 0);
ALTER TABLE order_lines ADD COLUMN received_quantity INTEGER NOT NULL DEFAULT 0 CHECK(received_quantity >= 0);

-- 5. Extend Stock Movements with Location Context & Reversal Tracing
ALTER TABLE stock_movements ADD COLUMN stock_type TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(stock_type IN ('AVAILABLE', 'DAMAGED', 'IN_TRANSIT'));
ALTER TABLE stock_movements ADD COLUMN reversal_of_movement_id INTEGER REFERENCES stock_movements(id) ON DELETE SET NULL;
ALTER TABLE stock_movements ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- 6. Physical Cycle Counts Ledger
CREATE TABLE IF NOT EXISTS cycle_counts (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id             INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id             INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  count_number            TEXT    NOT NULL,
  status                  TEXT    NOT NULL CHECK(status IN ('DRAFT', 'IN_PROGRESS', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED')) DEFAULT 'DRAFT',
  is_blind_count          INTEGER NOT NULL DEFAULT 1 CHECK(is_blind_count IN (0, 1)),
  assigned_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewer_notes          TEXT    DEFAULT '',
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at            TEXT    DEFAULT NULL,
  CONSTRAINT uq_cycle_count_number UNIQUE (business_id, count_number)
);

-- 7. Cycle Count Line Items
CREATE TABLE IF NOT EXISTS cycle_count_items (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_count_id       INTEGER NOT NULL REFERENCES cycle_counts(id) ON DELETE CASCADE,
  product_id           INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  system_on_hand       INTEGER NOT NULL,
  counted_qty          INTEGER DEFAULT NULL,
  recounted_qty        INTEGER DEFAULT NULL,
  final_counted_qty    INTEGER DEFAULT NULL,
  discrepancy_qty      INTEGER GENERATED ALWAYS AS (COALESCE(final_counted_qty, counted_qty, system_on_hand) - system_on_hand) VIRTUAL,
  discrepancy_value_cents INTEGER DEFAULT 0,
  reason_code          TEXT    DEFAULT 'UNEXPLAINED_DIFFERENCE' CHECK(reason_code IN ('DAMAGED_EXPIRED', 'MISCOUNT_RECOUNTED', 'THEFT_SUSPECTED', 'SUPPLIER_MISPACK', 'UNEXPLAINED_DIFFERENCE', 'INTERNAL_TRANSFER_MISMATCH')),
  notes                TEXT    DEFAULT '',
  is_resolved          INTEGER NOT NULL DEFAULT 0 CHECK(is_resolved IN (0, 1)),
  reconciled_movement_id INTEGER REFERENCES stock_movements(id) ON DELETE SET NULL,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 8. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_products_archived ON products(business_id, is_archived);
CREATE INDEX IF NOT EXISTS idx_cycle_counts_status ON cycle_counts(business_id, status);
CREATE INDEX IF NOT EXISTS idx_cycle_count_items_parent ON cycle_count_items(cycle_count_id, product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements(product_id, stock_type);
