/**
 * server.js — Smart Business Manager Application Entry Point
 */

'use strict';

const { createApp } = require('./src/app');
const { getDb } = require('./database/connection');
const { seedDatabase } = require('./database/seed');

const db = getDb();
seedDatabase(db);

const app = createApp(db);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Smart Business Manager Running at: http://localhost:${PORT}`);
  console.log(`   Listening on: ${HOST}:${PORT}`);
  console.log(`   Database    : SQLite WAL mode enabled`);
  console.log(`   Ready for wholesale inventory & intelligence operations`);
  console.log(`======================================================\n`);
});
