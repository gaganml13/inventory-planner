-- 006_user_is_active.sql
-- Adds is_active status flag to users for team deactivation support

PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1));
