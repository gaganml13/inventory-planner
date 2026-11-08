/**
 * auth_tenancy.test.js
 *
 * Validates Dual-Mode Tenant Isolation:
 * - Guest session automatically binds to demo-apex-wholesale tenant
 * - Registered email user gets an isolated business tenant
 * - Queries and stock data strictly isolate between tenants
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { DatabaseConnection } = require('../database/connection');
const { runMigrations } = require('../database/migrator');
const { seedDatabase } = require('../database/seed');
const AuthService = require('../src/modules/auth/auth_service');
const InventoryService = require('../src/modules/inventory/inventory_service');

const TEST_DB = path.join(__dirname, 'test_auth.db');

function setupTestDb() {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }
  const db = new DatabaseConnection(TEST_DB);
  runMigrations(db);
  seedDatabase(db);
  return db;
}

test('Tenant Isolation: Guest binds to demo tenant, registered user gets isolated private tenant', () => {
  const db = setupTestDb();
  const auth = new AuthService(db);
  const inv = new InventoryService(db);

  // 1. Guest login
  const guestSession = auth.loginGuest();
  assert.equal(guestSession.user.isGuest, true);
  assert.equal(guestSession.business.isDemo, true);

  // Demo tenant should have pre-seeded products
  const demoProducts = inv.getStockPositions(guestSession.business.id);
  assert.ok(demoProducts.length > 0, 'Demo tenant must contain seeded products');

  // 2. Register private email user
  const email = 'wholesale_admin@timbercorp.example.com';
  const regSession = auth.registerUser(email, 'SecurePass123!', 'Timberline Supplies');
  assert.equal(regSession.user.isGuest, false);
  assert.equal(regSession.business.isDemo, false);
  assert.notEqual(regSession.business.id, guestSession.business.id);

  // Fresh private tenant must start with 0 products (onboarding ready)
  const privateProducts = inv.getStockPositions(regSession.business.id);
  assert.equal(privateProducts.length, 0, 'Fresh private tenant must start with 0 products');

  // 3. Create a product in the private tenant
  inv.createProduct({
    businessId: regSession.business.id,
    sku: 'TIMBER-OAK-2X4',
    name: 'Hardwood Oak 2x4 Plank',
    category: 'Lumber',
    base_unit: 'planks',
    pack_size: 10,
    cost_price_cents: 800,
    sell_price_cents: 1400,
    initial_stock: 50
  });

  // Verify private tenant now has 1 product
  const privateAfter = inv.getStockPositions(regSession.business.id);
  assert.equal(privateAfter.length, 1);
  assert.equal(privateAfter[0].sku, 'TIMBER-OAK-2X4');

  // Verify demo tenant does NOT see the private tenant's SKU
  const demoAfter = inv.getStockPositions(guestSession.business.id);
  const leakedProduct = demoAfter.find(p => p.sku === 'TIMBER-OAK-2X4');
  assert.equal(leakedProduct, undefined, 'Demo tenant must not see private tenant SKUs');

  // 4. Session Validation
  const validated = auth.validateSession(regSession.token);
  assert.ok(validated);
  assert.equal(validated.user.email, email);
  assert.equal(validated.business.id, regSession.business.id);

  // 5. Session Deletion
  auth.deleteSession(regSession.token);
  const deleted = auth.validateSession(regSession.token);
  assert.equal(deleted, null, 'Deleted session must be invalid');
});
