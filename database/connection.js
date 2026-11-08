/**
 * connection.js — SQLite Database Connection & Transaction Manager
 *
 * Implements:
 * - Direct driver support for Node.js native `node:sqlite` (Node 22.5+, 24+) and `better-sqlite3`.
 * - Strict write-lock serialization using `BEGIN IMMEDIATE` to prevent deadlocks and race conditions.
 * - Enforced foreign keys and WAL mode.
 * - Dynamic parameter normalization (null-safe binding).
 */

'use strict';

const path = require('path');
const fs = require('fs');

function resolveDefaultDbPath() {
  if (process.env.DATA_DIR) {
    try {
      fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
    } catch (_) {}
    return process.env.NODE_ENV === 'test'
      ? path.join(process.env.DATA_DIR, 'test_inventory.db')
      : path.join(process.env.DATA_DIR, 'inventory.db');
  }
  return process.env.NODE_ENV === 'test'
    ? path.join(__dirname, '..', 'test_inventory.db')
    : path.join(__dirname, '..', 'inventory.db');
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();

class DatabaseConnection {
  constructor(customPath) {
    this.dbPath = customPath || process.env.DB_PATH || resolveDefaultDbPath();
    const dir = path.dirname(this.dbPath);
    if (dir && !fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }
    this.rawDb = null;
    this.isBetterSqlite = false;
    this.init();
  }

  init() {
    try {
      const BetterSqlite3 = require('better-sqlite3');
      this.rawDb = new BetterSqlite3(this.dbPath);
      this.rawDb.pragma('journal_mode = WAL');
      this.rawDb.pragma('foreign_keys = ON');
      this.isBetterSqlite = true;
    } catch (err) {
      const { DatabaseSync } = require('node:sqlite');
      this.rawDb = new DatabaseSync(this.dbPath);
      this.rawDb.exec('PRAGMA journal_mode = WAL;');
      this.rawDb.exec('PRAGMA foreign_keys = ON;');
      this.isBetterSqlite = false;
    }
  }

  normalizeParam(param) {
    return param === undefined ? null : param;
  }

  exec(sql) {
    return this.rawDb.exec(sql);
  }

  prepare(sql) {
    const stmt = this.rawDb.prepare(sql);
    const self = this;

    return {
      run(...params) {
        const cleanParams = params.map(self.normalizeParam);
        const res = stmt.run(...cleanParams);
        return {
          changes: res.changes,
          lastInsertRowid: Number(res.lastInsertRowid)
        };
      },
      get(...params) {
        const cleanParams = params.map(self.normalizeParam);
        const row = stmt.get(...cleanParams);
        return row ? { ...row } : undefined;
      },
      all(...params) {
        const cleanParams = params.map(self.normalizeParam);
        const rows = stmt.all(...cleanParams);
        return rows.map((r) => ({ ...r }));
      }
    };
  }

  /**
   * Executes callback within an immediate transaction: `BEGIN IMMEDIATE`
   * Ensures exclusive write lock before reading or modifying balances.
   */
  transaction(fn) {
    return (...args) => {
      this.rawDb.exec('BEGIN IMMEDIATE;');
      try {
        const result = fn(...args);
        this.rawDb.exec('COMMIT;');
        return result;
      } catch (err) {
        try {
          this.rawDb.exec('ROLLBACK;');
        } catch (rollbackErr) {
          // If transaction is already rolled back or invalid, ignore
        }
        throw err;
      }
    };
  }

  close() {
    if (this.rawDb && typeof this.rawDb.close === 'function') {
      this.rawDb.close();
    }
  }
}

// Singleton for application runtime
let defaultInstance = null;

function getDb(customPath) {
  if (customPath) {
    return new DatabaseConnection(customPath);
  }
  if (!defaultInstance) {
    defaultInstance = new DatabaseConnection();
  }
  return defaultInstance;
}

function resetDbInstance() {
  if (defaultInstance) {
    try {
      defaultInstance.close();
    } catch (e) {}
    defaultInstance = null;
  }
}

module.exports = {
  DatabaseConnection,
  getDb,
  resetDbInstance
};
