/**
 * cycle_count_service.js — Physical Cycle Counting, Blind Audits & Approval Governance
 *
 * Implements:
 * - Blind counting (hiding system on-hand from warehouse counters)
 * - Recount workflows
 * - Discrepancy case logging (treated as unexplained differences, not proof of theft)
 * - Reason codes (DAMAGED_EXPIRED, MISCOUNT_RECOUNTED, SUPPLIER_MISPACK, UNEXPLAINED_DIFFERENCE, etc.)
 * - Configurable monetary approval threshold requiring OWNER authorization
 * - Traceable stock reconciliation into immutable stock_movements ledger
 */

'use strict';

const { getDb } = require('../../../database/connection');
const InventoryService = require('./inventory_service');

class CycleCountService {
  constructor(customDb) {
    this.db = customDb || getDb();
    this.inventoryService = new InventoryService(this.db);
  }

  /**
   * Initiates a physical cycle count event for a location.
   */
  createCycleCount({
    businessId,
    locationId,
    countNumber = null,
    isBlindCount = true,
    assignedUserId = null,
    productIds = null // null means all active products at this location
  }) {
    if (!businessId || !locationId) {
      const err = new Error('businessId and locationId are required');
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const loc = this.db.prepare('SELECT id, name FROM locations WHERE id = ? AND business_id = ?').get(locationId, businessId);
    if (!loc) {
      const err = new Error(`Location #${locationId} not found`);
      err.code = 'LOCATION_NOT_FOUND';
      throw err;
    }

    const num = countNumber || `CC-${Date.now().toString().slice(-6)}`;

    let createdId;

    const tx = this.db.transaction(() => {
      // 1. Create cycle_counts header
      const headerRes = this.db.prepare(`
        INSERT INTO cycle_counts (
          business_id, location_id, count_number, status, is_blind_count, assigned_user_id
        ) VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?)
      `).run(businessId, locationId, num, isBlindCount ? 1 : 0, assignedUserId || null);

      createdId = headerRes.lastInsertRowid;

      // 2. Fetch target products
      let prodSql = 'SELECT id, sku, name, cost_price_cents FROM products WHERE business_id = ? AND is_archived = 0';
      const params = [businessId];
      if (Array.isArray(productIds) && productIds.length > 0) {
        prodSql += ` AND id IN (${productIds.map(() => '?').join(',')})`;
        params.push(...productIds);
      }
      const products = this.db.prepare(prodSql).all(...params);

      // 3. Capture current system on_hand snapshot per product
      const itemInsert = this.db.prepare(`
        INSERT INTO cycle_count_items (
          cycle_count_id, product_id, system_on_hand, reason_code
        ) VALUES (?, ?, ?, 'UNEXPLAINED_DIFFERENCE')
      `);

      for (const p of products) {
        const balRow = this.db.prepare(`
          SELECT COALESCE(SUM(change_qty), 0) AS on_hand
          FROM stock_movements
          WHERE business_id = ? AND product_id = ? AND location_id = ?
            AND (stock_type = 'AVAILABLE' OR stock_type IS NULL)
        `).get(businessId, p.id, locationId);

        const currentSystemOnHand = balRow ? balRow.on_hand : 0;
        itemInsert.run(createdId, p.id, currentSystemOnHand);
      }
    });

    tx();
    return this.getCycleCountById(createdId, businessId);
  }

  /**
   * Records count entries submitted by warehouse staff.
   */
  recordCounts({ cycleCountId, businessId, counts, userId = null }) {
    const cc = this.db.prepare('SELECT * FROM cycle_counts WHERE id = ? AND business_id = ?').get(cycleCountId, businessId);
    if (!cc) {
      const err = new Error(`Cycle count #${cycleCountId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (!['IN_PROGRESS', 'DRAFT'].includes(cc.status)) {
      const err = new Error(`Cannot record counts for cycle count in status ${cc.status}`);
      err.code = 'INVALID_STATE';
      throw err;
    }

    const tx = this.db.transaction(() => {
      const updateStmt = this.db.prepare(`
        UPDATE cycle_count_items
        SET counted_qty = ?,
            final_counted_qty = ?,
            reason_code = COALESCE(?, reason_code),
            notes = COALESCE(?, notes),
            discrepancy_value_cents = (? - system_on_hand) * (SELECT cost_price_cents FROM products WHERE id = product_id)
        WHERE cycle_count_id = ? AND product_id = ?
      `);

      for (const item of counts) {
        const counted = parseInt(item.counted_qty, 10);
        if (isNaN(counted) || counted < 0) continue;

        updateStmt.run(
          counted,
          counted,
          item.reason_code || 'UNEXPLAINED_DIFFERENCE',
          item.notes || '',
          counted,
          cycleCountId,
          item.product_id
        );
      }
    });

    tx();
    return this.getCycleCountById(cycleCountId, businessId);
  }

  /**
   * Submits cycle count for managerial review.
   */
  submitForApproval(cycleCountId, businessId) {
    const cc = this.db.prepare('SELECT * FROM cycle_counts WHERE id = ? AND business_id = ?').get(cycleCountId, businessId);
    if (!cc) {
      const err = new Error(`Cycle count #${cycleCountId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    this.db.prepare("UPDATE cycle_counts SET status = 'PENDING_APPROVAL' WHERE id = ?").run(cycleCountId);
    return this.getCycleCountById(cycleCountId, businessId);
  }

  /**
   * Approves cycle count reconciliation and applies stock adjustments.
   * Enforces server-side monetary approval threshold for significant write-offs.
   */
  approveCycleCount({ cycleCountId, businessId, reviewerUserId, reviewerNotes = '', userRole = 'OWNER' }) {
    let result;

    const tx = this.db.transaction(() => {
      const cc = this.db.prepare(`
        SELECT cc.*, b.approval_threshold_cents
        FROM cycle_counts cc
        JOIN businesses b ON cc.business_id = b.id
        WHERE cc.id = ? AND cc.business_id = ?
      `).get(cycleCountId, businessId);

      if (!cc) {
        const err = new Error(`Cycle count #${cycleCountId} not found`);
        err.code = 'NOT_FOUND';
        throw err;
      }

      if (cc.status === 'APPROVED') {
        const err = new Error('Cycle count is already approved and reconciled');
        err.code = 'ALREADY_APPROVED';
        throw err;
      }

      const items = this.db.prepare(`
        SELECT cci.*, p.sku, p.name, p.cost_price_cents
        FROM cycle_count_items cci
        JOIN products p ON cci.product_id = p.id
        WHERE cci.cycle_count_id = ?
      `).all(cycleCountId);

      // Calculate total discrepancy absolute value
      let totalDiscrepancyValueCents = 0;
      for (const item of items) {
        const finalCount = item.final_counted_qty !== null ? item.final_counted_qty : item.counted_qty;
        if (finalCount !== null) {
          const diff = finalCount - item.system_on_hand;
          totalDiscrepancyValueCents += Math.abs(diff * (item.cost_price_cents || 0));
        }
      }

      // Check monetary threshold requiring OWNER role
      const threshold = cc.approval_threshold_cents || 50000;
      if (totalDiscrepancyValueCents > threshold && userRole !== 'OWNER') {
        const err = new Error(
          `Total discrepancy value ($${(totalDiscrepancyValueCents / 100).toFixed(2)}) exceeds the approval threshold of $${(threshold / 100).toFixed(2)}. Only an account OWNER can approve this reconciliation.`
        );
        err.code = 'APPROVAL_THRESHOLD_EXCEEDED';
        throw err;
      }

      // Post atomic inventory adjustments for discrepancies
      for (const item of items) {
        const finalCount = item.final_counted_qty !== null ? item.final_counted_qty : item.counted_qty;
        if (finalCount === null) continue;

        const diff = finalCount - item.system_on_hand;
        if (diff !== 0) {
          // Adjust stock to match physical count
          this.inventoryService.adjustStock({
            businessId,
            productId: item.product_id,
            locationId: cc.location_id,
            changeQty: diff,
            reason: `CYCLE_COUNT_ADJUSTMENT (${item.reason_code || 'UNEXPLAINED_DIFFERENCE'}): ${item.notes || cc.count_number}`,
            stockType: 'AVAILABLE',
            userId: reviewerUserId,
            insideTransaction: true
          });

          // Mark item resolved
          this.db.prepare(`
            UPDATE cycle_count_items 
            SET is_resolved = 1 
            WHERE id = ?
          `).run(item.id);
        } else {
          this.db.prepare(`
            UPDATE cycle_count_items 
            SET is_resolved = 1 
            WHERE id = ?
          `).run(item.id);
        }
      }

      // Finalize cycle count
      this.db.prepare(`
        UPDATE cycle_counts
        SET status = 'APPROVED',
            reviewed_by_user_id = ?,
            reviewer_notes = ?,
            completed_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        WHERE id = ?
      `).run(reviewerUserId || null, reviewerNotes || '', cycleCountId);

      result = this.getCycleCountById(cycleCountId, businessId);
    });

    tx();
    return result;
  }

  /**
   * Rejects cycle count.
   */
  rejectCycleCount({ cycleCountId, businessId, reviewerUserId, reviewerNotes = '' }) {
    this.db.prepare(`
      UPDATE cycle_counts
      SET status = 'REJECTED',
          reviewed_by_user_id = ?,
          reviewer_notes = ?,
          completed_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE id = ? AND business_id = ?
    `).run(reviewerUserId || null, reviewerNotes || '', cycleCountId, businessId);

    return this.getCycleCountById(cycleCountId, businessId);
  }

  /**
   * Retrieves cycle count with items, optionally hiding system on-hand if active blind count.
   */
  getCycleCountById(cycleCountId, businessId, maskBlindCounts = false) {
    const cc = this.db.prepare(`
      SELECT cc.*, l.name AS location_name, u.name AS assigned_user_name, r.name AS reviewer_name
      FROM cycle_counts cc
      JOIN locations l ON cc.location_id = l.id
      LEFT JOIN users u ON cc.assigned_user_id = u.id
      LEFT JOIN users r ON cc.reviewed_by_user_id = r.id
      WHERE cc.id = ? AND cc.business_id = ?
    `).get(cycleCountId, businessId);

    if (!cc) return null;

    const items = this.db.prepare(`
      SELECT 
        cci.*,
        p.sku,
        p.name AS product_name,
        p.category,
        p.base_unit,
        p.pack_size,
        p.cost_price_cents
      FROM cycle_count_items cci
      JOIN products p ON cci.product_id = p.id
      WHERE cci.cycle_count_id = ?
      ORDER BY p.sku ASC
    `).all(cycleCountId);

    const isBlindActive = Boolean(cc.is_blind_count) && ['IN_PROGRESS', 'DRAFT'].includes(cc.status) && maskBlindCounts;

    const sanitizedItems = items.map((i) => ({
      ...i,
      system_on_hand: isBlindActive ? null : i.system_on_hand,
      discrepancy_qty: isBlindActive ? null : (i.counted_qty !== null ? (i.counted_qty - i.system_on_hand) : 0),
      discrepancy_value_cents: isBlindActive ? null : (i.counted_qty !== null ? ((i.counted_qty - i.system_on_hand) * (i.cost_price_cents || 0)) : 0)
    }));

    return {
      ...cc,
      is_blind_count: Boolean(cc.is_blind_count),
      items: sanitizedItems
    };
  }

  /**
   * Lists cycle counts for a business.
   */
  listCycleCounts(businessId, status = null) {
    let sql = `
      SELECT 
        cc.*,
        l.name AS location_name,
        u.name AS assigned_user_name,
        (SELECT COUNT(*) FROM cycle_count_items WHERE cycle_count_id = cc.id) AS item_count,
        (SELECT COUNT(*) FROM cycle_count_items WHERE cycle_count_id = cc.id AND counted_qty IS NOT NULL) AS counted_count,
        (SELECT COUNT(*) FROM cycle_count_items WHERE cycle_count_id = cc.id AND counted_qty IS NOT NULL AND (counted_qty - system_on_hand) != 0) AS discrepancy_count
      FROM cycle_counts cc
      JOIN locations l ON cc.location_id = l.id
      LEFT JOIN users u ON cc.assigned_user_id = u.id
      WHERE cc.business_id = ?
    `;
    const params = [businessId];
    if (status) {
      sql += ' AND cc.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY cc.id DESC';
    return this.db.prepare(sql).all(...params);
  }
}

module.exports = CycleCountService;
