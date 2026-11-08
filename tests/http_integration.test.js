/**
 * http_integration.test.js
 *
 * Verifies end-to-end HTTP routes:
 * - Unauthenticated request gets 401 or redirected
 * - POST /api/auth/guest establishes HTTP-only cookie session
 * - GET /api/metrics scopes to demo tenant
 * - GET /api/intelligence/recommendations returns StockTrim-style records
 * - POST /api/auth/register creates isolated tenant with 0 SKUs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { DatabaseConnection } = require('../database/connection');
const { runMigrations } = require('../database/migrator');
const { seedDatabase } = require('../database/seed');
const { createApp } = require('../src/app');

const TEST_DB = path.join(__dirname, 'test_http.db');

function setupTestDb() {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }
  const db = new DatabaseConnection(TEST_DB);
  runMigrations(db);
  seedDatabase(db);
  return db;
}

test('HTTP End-to-End: Auth flow, cookie sessions, tenant isolation & StockTrim metrics', async (t) => {
  const db = setupTestDb();
  const app = createApp(db);

  // Bind to ephemeral port
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Unauthenticated API request must be rejected with 401
    const unauthRes = await fetch(`${baseUrl}/api/metrics`, {
      headers: { 'Accept': 'application/json' }
    });
    assert.equal(unauthRes.status, 401, 'Unauthenticated request must return 401');

    // 2. Guest Login
    const guestRes = await fetch(`${baseUrl}/api/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(guestRes.status, 200);
    const guestData = await guestRes.json();
    assert.equal(guestData.success, true);
    assert.equal(guestData.user.isGuest, true);
    assert.equal(guestData.business.isDemo, true);

    // Extract session cookie
    const cookieHeader = guestRes.headers.get('set-cookie');
    assert.ok(cookieHeader && cookieHeader.includes('session='), 'Must set session cookie');
    const sessionCookie = cookieHeader.split(';')[0];

    // 3. Authenticated Metrics Request
    const metricsRes = await fetch(`${baseUrl}/api/metrics`, {
      headers: { 'Cookie': sessionCookie }
    });
    assert.equal(metricsRes.status, 200);
    const metrics = await metricsRes.json();
    assert.ok(metrics.totalItems > 0, 'Demo tenant must have products');
    assert.ok(metrics.freeWorkingCapitalCents > 0);
    assert.ok(metrics.workingCapitalAvailableCents !== undefined);

    // 4. Authenticated Recommendations Request
    const recsRes = await fetch(`${baseUrl}/api/intelligence/recommendations`, {
      headers: { 'Cookie': sessionCookie }
    });
    assert.equal(recsRes.status, 200);
    const recs = await recsRes.json();
    assert.ok(Array.isArray(recs), 'Recommendations must be an array');
    assert.ok(recs.length > 0, 'Demo tenant must generate replenishment recommendations');

    const firstRec = recs[0];
    assert.ok(firstRec.evidence, 'Must have explainability evidence');
    assert.ok(firstRec.evidence.why, 'Must have "why" rationale');
    assert.ok(firstRec.evidence.what_to_buy, 'Must have "what_to_buy"');

    // 5. Register Private User
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'private_owner@storecorp.example.com',
        password: 'Password123!',
        businessName: 'StoreCorp Wholesale'
      })
    });
    assert.equal(regRes.status, 200);
    const regData = await regRes.json();
    assert.equal(regData.user.isGuest, false);
    assert.equal(regData.business.isDemo, false);

    const privateCookie = regRes.headers.get('set-cookie').split(';')[0];

    // Check private tenant products (must be 0 on fresh account)
    const privPositionsRes = await fetch(`${baseUrl}/api/inventory/positions`, {
      headers: { 'Cookie': privateCookie }
    });
    const privPositions = await privPositionsRes.json();
    assert.equal(privPositions.length, 0, 'Fresh registered tenant must have 0 SKUs');

    // 6. Logout
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Cookie': privateCookie }
    });
    assert.equal(logoutRes.status, 200);

    // Attempting to access API after logout must fail with 401
    const postLogoutRes = await fetch(`${baseUrl}/api/inventory/positions`, {
      headers: { 'Cookie': privateCookie, 'Accept': 'application/json' }
    });
    assert.equal(postLogoutRes.status, 401);

  } finally {
    server.close();
  }
});
