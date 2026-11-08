/**
 * demand_aggregator.js — Historical Daily Demand Aggregator with Stockout Censoring
 *
 * Implements:
 * - Daily unit sales aggregation per SKU.
 * - Continuous calendar timeline interpolation (filling zero-sales days).
 * - Stockout Censoring: days where end-of-day stock was 0 are flagged as censored demand
 *   (true customer interest was masked by lack of stock), preventing downward bias.
 */

'use strict';

const { getDb } = require('../../../database/connection');

class DemandAggregator {
  constructor(customDb) {
    this.db = customDb || getDb();
  }

  /**
   * Aggregates daily demand for a product over a lookback window (e.g. 60 days).
   * Returns sorted array of daily points:
   * [{ date: '2026-09-01', salesQty: 5, stockBalance: 20, isStockout: false, adjustedDemand: 5 }]
   */
  getDailyDemandHistory(businessId, productId, daysBack = 60, asOfDate = null) {
    const endDate = asOfDate ? new Date(asOfDate) : new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const startDate = new Date(endDate.getTime() - daysBack * dayMs);

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    // 1. Fetch daily sales from fulfilled & confirmed sale order lines
    const salesRows = this.db.prepare(`
      SELECT 
        date(o.order_date) AS sale_date,
        SUM(ol.quantity) AS daily_qty,
        COUNT(DISTINCT o.id) AS order_count
      FROM order_lines ol
      JOIN orders o ON ol.order_id = o.id
      WHERE o.business_id = ? AND ol.product_id = ? 
        AND o.type = 'SALE' AND o.status IN ('CONFIRMED', 'FULFILLED')
        AND date(o.order_date) >= ? AND date(o.order_date) <= ?
      GROUP BY date(o.order_date)
      ORDER BY sale_date ASC
    `).all(businessId, productId, startDateStr, endDateStr);

    const salesMap = {};
    salesRows.forEach((r) => {
      salesMap[r.sale_date] = {
        qty: Number(r.daily_qty) || 0,
        orders: Number(r.order_count) || 0
      };
    });

    // 2. Fetch stock movements to reconstruct end-of-day balance
    const movementRows = this.db.prepare(`
      SELECT 
        date(created_at) AS move_date,
        balance_after
      FROM stock_movements
      WHERE business_id = ? AND product_id = ?
        AND date(created_at) <= ?
      ORDER BY id ASC
    `).all(businessId, productId, endDateStr);

    const balanceByDate = {};
    movementRows.forEach((m) => {
      balanceByDate[m.move_date] = m.balance_after;
    });

    // 3. Continuous timeline generation
    const dailySeries = [];
    let lastKnownBalance = 0;

    // Find latest balance prior to start date if any
    const priorMovement = this.db.prepare(`
      SELECT balance_after FROM stock_movements
      WHERE business_id = ? AND product_id = ? AND date(created_at) < ?
      ORDER BY id DESC LIMIT 1
    `).get(businessId, productId, startDateStr);
    if (priorMovement) {
      lastKnownBalance = priorMovement.balance_after;
    }

    const currDate = new Date(startDate);
    while (currDate <= endDate) {
      const dStr = currDate.toISOString().split('T')[0];
      const sales = salesMap[dStr] ? salesMap[dStr].qty : 0;
      const orderCount = salesMap[dStr] ? salesMap[dStr].orders : 0;

      if (balanceByDate[dStr] !== undefined) {
        lastKnownBalance = balanceByDate[dStr];
      }

      // Stockout definition: balance is 0 or negative
      const isStockout = lastKnownBalance <= 0;

      dailySeries.push({
        date: dStr,
        dayOfWeek: currDate.getUTCDay(),
        salesQty: sales,
        quantity: sales,
        orderCount,
        stockBalance: lastKnownBalance,
        isStockout,
        adjustedDemand: sales // will be refined by censor handler
      });

      currDate.setTime(currDate.getTime() + dayMs);
    }

    // 4. Adjust for Stockouts (Censored Demand Correction)
    // If a day had 0 sales because inventory was 0, customer interest wasn't 0.
    // Impute using local rolling median/mean of non-stockout days.
    const nonStockoutSales = dailySeries.filter((d) => !d.isStockout && d.salesQty > 0).map((d) => d.salesQty);
    const baselineAverage = nonStockoutSales.length > 0
      ? nonStockoutSales.reduce((a, b) => a + b, 0) / nonStockoutSales.length
      : 1.0;

    for (let i = 0; i < dailySeries.length; i++) {
      const pt = dailySeries[i];
      if (pt.isStockout && pt.salesQty === 0) {
        // Look at preceding 7 days non-stockout average
        const window = dailySeries.slice(Math.max(0, i - 7), i).filter((w) => !w.isStockout);
        if (window.length > 0) {
          const sum = window.reduce((acc, cur) => acc + cur.salesQty, 0);
          pt.adjustedDemand = parseFloat((sum / window.length).toFixed(2));
        } else {
          pt.adjustedDemand = parseFloat(baselineAverage.toFixed(2));
        }
      }
    }

    return dailySeries;
  }
}

module.exports = DemandAggregator;
