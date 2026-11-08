-- 002_auth_and_tenancy.sql
-- Authentication, User Accounts, and Dual-Mode Tenant Isolation (Guest Demo vs Private Workspace)

PRAGMA foreign_keys = ON;

-- 1. Extend businesses table with slug and demo indicator
ALTER TABLE businesses ADD COLUMN slug TEXT DEFAULT '';
ALTER TABLE businesses ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;

-- 2. Users Table
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  name          TEXT    NOT NULL DEFAULT '',
  business_id   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  is_guest      INTEGER NOT NULL DEFAULT 0 CHECK(is_guest IN (0, 1)),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 3. Sessions Table (HTTP-Only Cookie Backing)
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  expires_at  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 4. Indices
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_businesses_slug ON businesses(slug);
