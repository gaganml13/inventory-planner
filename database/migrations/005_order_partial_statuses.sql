-- 005_order_partial_statuses.sql
-- Update orders table to allow PARTIALLY_RECEIVED and PARTIALLY_FULFILLED statuses

CREATE TABLE IF NOT EXISTS orders_new (
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

INSERT OR REPLACE INTO orders_new (
  id, business_id, contact_id, order_number, type, status, order_date, due_date, total_cents, paid_cents, notes, allow_backorder, source_tag, created_at
)
SELECT id, business_id, contact_id, order_number, type, status, order_date, due_date, total_cents, paid_cents, notes, allow_backorder, source_tag, created_at
FROM orders;

DROP TABLE orders;

ALTER TABLE orders_new RENAME TO orders;

CREATE INDEX IF NOT EXISTS idx_orders_business_type ON orders(business_id, type, status);
CREATE INDEX IF NOT EXISTS idx_orders_contact ON orders(contact_id);
