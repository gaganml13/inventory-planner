/**
 * migrator.js — Modular SQL Migration Runner
 *
 * Tracks applied migrations in `schema_migrations` table and applies
 * unapplied `.sql` files in `./database/migrations/` sequentially.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getDb } = require('./connection');

function runMigrations(customDb) {
  const db = customDb || getDb();

  // Ensure migrations tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      filename   TEXT    NOT NULL UNIQUE,
      applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const appliedRows = db.prepare('SELECT filename FROM schema_migrations').all();
  const appliedSet = new Set(appliedRows.map((r) => r.filename));

  const appliedNow = [];
  db.exec('PRAGMA foreign_keys = OFF;');

  try {
    for (const file of files) {
      if (!appliedSet.has(file)) {
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');

        // Execute migration and record in tracking table within a transaction
        const applyTx = db.transaction(() => {
          db.exec(sql);
          db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
        });

        applyTx();
        appliedNow.push(file);
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }

  return appliedNow;
}

if (require.main === module) {
  const applied = runMigrations();
  console.log(`Applied ${applied.length} migration(s):`, applied);
}

module.exports = { runMigrations };
