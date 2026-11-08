/**
 * reorder_engine.js — Deterministic Reorder Intelligence with Cash Working Capital Prioritization
 *
 * Implements:
 * 1. Safety Stock: SS = Z * sqrt(L * sigma_D^2 + D^2 * sigma_L^2) with Z = 1.65 (95% service level).
 * 2. Net Requirement: max(0, (Forecast_L + SS) - Available - Incoming).
 * 3. Pack-size snapping: Ceil(NetReq / pack_size) * pack_size.
 * 4. Cash Prioritization:
 *    - Reads business cash_reserve_cents, operating_cash_cents, and pending AP bills due within lead window.
 *    - Ranks candidate items by Velocity * Unit Margin.
 *    - Allocates recommendations strictly within available working capital.
 * 5. Structured Explainability: what, why, uncertainty, next_action.
 */

'use strict';

const { getDb } = require('../../../database/connection');
const DemandAggregator = require('./demand_aggregator');
const Forecaster = require('./forecaster');

class ReorderEngine {
  constructor(customDb) {
    this.db = customDb || getDb();
    this.aggregator = new DemandAggregator(this.db);
    this.forecaster = new Forecaster();
  }

  /**
   * Computes standard deviation of an array of numbers.
   */
  stdDev(arr) {
    if (arr.length < 2) return 0.5;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }

  /**
   * Evaluates all products for a business and produces prioritized purchase recommendations.
   */
  computeRecommendations(businessId) {
    // 1. Fetch business financial constraints
    const biz = this.db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId) || {
      cash_reserve_cents: 5000000,
      operating_cash_cents: 15000000
    };

    const cashReserveCents = biz.cash_reserve_cents || 0;
    const operatingCashCents = biz.operating_cash_cents || 0;

    // Fetch active (non-archived) products
    const products = this.db.prepare('SELECT * FROM products WHERE business_id = ? AND COALESCE(is_archived, 0) = 0 ORDER BY id ASC').all(businessId);

    // Fetch inventory positions and in-flight purchase orders (both CONFIRMED and DRAFT)
    const positions = {};
    const posRows = this.db.prepare(`
      SELECT 
        p.id AS product_id,
        COALESCE(sm.on_hand, 0) AS on_hand,
        COALESCE(res.reserved, 0) AS reserved,
        (COALESCE(sm.on_hand, 0) - COALESCE(res.reserved, 0)) AS available,
        COALESCE(inc.incoming_po, 0) AS incoming_po,
        COALESCE(draft.draft_po, 0) AS draft_po
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(change_qty) AS on_hand FROM stock_movements WHERE business_id = ? GROUP BY product_id
      ) sm ON p.id = sm.product_id
      LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity - COALESCE(ol.fulfilled_quantity, 0)) AS reserved FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id WHERE o.business_id = ? AND o.type = 'SALE' AND o.status IN ('CONFIRMED', 'PARTIALLY_FULFILLED')
        GROUP BY ol.product_id
      ) res ON p.id = res.product_id
      LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity - COALESCE(ol.received_quantity, 0)) AS incoming_po FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id WHERE o.business_id = ? AND o.type = 'PURCHASE' AND o.status IN ('CONFIRMED', 'PARTIALLY_RECEIVED')
        GROUP BY ol.product_id
      ) inc ON p.id = inc.product_id
      LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity) AS draft_po FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id WHERE o.business_id = ? AND o.type = 'PURCHASE' AND o.status = 'DRAFT'
        GROUP BY ol.product_id
      ) draft ON p.id = draft.product_id
      WHERE p.business_id = ?
    `).all(businessId, businessId, businessId, businessId, businessId);

    posRows.forEach((r) => {
      positions[r.product_id] = r;
    });

    // 2. Fetch pending accounts payable due within the next 14 days
    const pendingApRow = this.db.prepare(`
      SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS pending_ap_cents
      FROM orders
      WHERE business_id = ? AND type = 'PURCHASE' AND status IN ('CONFIRMED', 'FULFILLED', 'PARTIALLY_RECEIVED')
        AND paid_cents < total_cents
        AND due_date <= date('now', '+14 days')
    `).get(businessId);

    const pendingApCents = pendingApRow ? pendingApRow.pending_ap_cents : 0;
    const availableWorkingCapitalCents = Math.max(0, operatingCashCents - cashReserveCents - pendingApCents);

    const candidateRecommendations = [];

    // 3. Evaluate each product
    for (const prod of products) {
      const pos = positions[prod.id] || { on_hand: 0, reserved: 0, available: 0, incoming_po: 0, draft_po: 0 };
      const available = pos.available;
      const incomingConfirmed = pos.incoming_po;
      const draftPo = pos.draft_po;
      const totalInFlight = incomingConfirmed + draftPo;

      // Extract daily demand history
      const history = this.aggregator.getDailyDemandHistory(businessId, prod.id, 60);
      const leadTime = Math.max(1, prod.lead_days || 7);
      const forecast = this.forecaster.generateForecast(history, leadTime);

      const dailyDemand = Math.max(0.1, forecast.dailyMean);
      const dailySalesVals = history.map((h) => h.adjustedDemand);
      const sigmaDemand = Math.max(0.2, this.stdDev(dailySalesVals));
      const sigmaLead = Math.max(0.5, leadTime * 0.15); // 15% lead time variance

      // Formula 1: Safety Stock (Z = 1.65 for 95% service level)
      const Z = 1.65;
      const varianceTerm = (leadTime * Math.pow(sigmaDemand, 2)) + (Math.pow(dailyDemand, 2) * Math.pow(sigmaLead, 2));
      const calculatedSafetyStock = Math.ceil(Z * Math.sqrt(Math.max(0.01, varianceTerm)));
      const safetyStock = Math.max(prod.min_safety_stock || 0, calculatedSafetyStock);

      // Formula 2: Net Requirement (accounting for in-flight confirmed AND draft POs to prevent duplicate ordering)
      const forecastDemandLead = Math.ceil(dailyDemand * leadTime);
      const grossRequirement = forecastDemandLead + safetyStock;
      const netRequirement = Math.max(0, grossRequirement - available - totalInFlight);

      if (netRequirement > 0) {
        // Formula 3: Snap to whole pack size & enforce Minimum Order Quantity (MOQ)
        const packSize = Math.max(1, prod.pack_size || 1);
        const moq = Math.max(1, prod.min_order_qty || 1);
        let packsToOrder = Math.ceil(netRequirement / packSize);
        let recommendedQty = packsToOrder * packSize;

        if (recommendedQty < moq) {
          packsToOrder = Math.ceil(moq / packSize);
          recommendedQty = packsToOrder * packSize;
        }

        const totalCostCents = recommendedQty * prod.cost_price_cents;

        // Formula 4: Ranking Score = Unit Margin * Velocity
        const unitMarginCents = Math.max(1, prod.sell_price_cents - prod.cost_price_cents);
        const velocity = dailyDemand;
        const marginVelocityScore = unitMarginCents * velocity;

        // Current cover days
        const coverDays = dailyDemand > 0 ? parseFloat((pos.on_hand / dailyDemand).toFixed(1)) : 999;

        // Structured Explainability breakdown
        const evidence = {
          what_to_buy: {
            sku: prod.sku,
            name: prod.name,
            recommended_qty: recommendedQty,
            pack_size: packSize,
            packs_count: packsToOrder,
            min_order_qty: moq,
            unit_cost_cents: prod.cost_price_cents,
            total_cost_cents: totalCostCents
          },
          why: {
            daily_demand_velocity: parseFloat(dailyDemand.toFixed(2)),
            lead_time_days: leadTime,
            current_cover_days: coverDays,
            safety_stock_units: safetyStock,
            available_stock: available,
            incoming_po: incomingConfirmed,
            open_draft_po: draftPo,
            lead_demand_forecast: forecastDemandLead,
            trend_signal: forecast.baselines.ma7 >= forecast.baselines.ma28 ? 'ACCELERATING' : 'NORMAL'
          },
          supporting_records: {
            sales_days_analyzed: history.length,
            non_zero_sales_events: history.filter((h) => h.salesQty > 0).length,
            stockouts_detected: history.filter((h) => h.isStockout).length
          },
          uncertainty: {
            score: forecast.uncertaintyScore,
            level: forecast.uncertaintyLevel,
            model_used: forecast.modelName,
            demand_pattern: forecast.classification?.pattern || 'SMOOTH',
            adi: forecast.classification?.adi || 1.0,
            cv2: forecast.classification?.cv2 || 0.1,
            data_points: history.length
          },
          next_action: `Review & Generate Draft PO for ${packsToOrder} pack(s) (${recommendedQty} ${prod.base_unit}) at $${(totalCostCents / 100).toFixed(2)}`
        };

        candidateRecommendations.push({
          productId: prod.id,
          sku: prod.sku,
          name: prod.name,
          category: prod.category,
          recommendedQty,
          packsToOrder,
          packSize,
          costCents: totalCostCents,
          unitMarginCents,
          velocity,
          score: marginVelocityScore,
          coverDays,
          uncertaintyLevel: forecast.uncertaintyLevel,
          uncertaintyScore: forecast.uncertaintyScore,
          evidence
        });
      }
    }

    // 4. Cash Working Capital Allocation & Prioritization
    candidateRecommendations.sort((a, b) => b.score - a.score);

    let remainingBudget = availableWorkingCapitalCents;
    const prioritizedResults = [];

    for (let i = 0; i < candidateRecommendations.length; i++) {
      const cand = candidateRecommendations[i];
      const rank = i + 1;
      let finalStatus = 'PENDING';
      let finalQty = cand.recommendedQty;
      let finalCost = cand.costCents;

      if (finalCost <= remainingBudget) {
        remainingBudget -= finalCost;
        finalStatus = 'PENDING'; // Ready for review & draft PO creation
      } else {
        // Cannot afford full requirement within working capital
        const unitCost = cand.evidence.what_to_buy.unit_cost_cents;
        const packCost = unitCost * cand.packSize;

        if (remainingBudget >= packCost) {
          const affordablePacks = Math.floor(remainingBudget / packCost);
          finalQty = affordablePacks * cand.packSize;
          finalCost = affordablePacks * packCost;
          remainingBudget -= finalCost;
          cand.evidence.next_action = `Partial PO generated: Budget constrained to ${affordablePacks} pack(s). Remaining requirement deferred.`;
          finalStatus = 'PENDING';
        } else {
          finalStatus = 'REJECTED'; // Flagged as budget-capped
          cand.evidence.next_action = 'Deferred: Insufficient free working capital after reserve and upcoming AP obligations.';
        }
      }

      prioritizedResults.push({
        businessId,
        productId: cand.productId,
        sku: cand.sku,
        name: cand.name,
        category: cand.category,
        recommendedQty: finalQty,
        costCents: finalCost,
        priorityRank: rank,
        status: finalStatus,
        evidence: cand.evidence
      });
    }

    // 5. Save recommendations to database
    const saveTx = this.db.transaction(() => {
      // Clear previous pending recommendations
      this.db.prepare("DELETE FROM purchase_recommendations WHERE business_id = ? AND status = 'PENDING'").run(businessId);

      const insertRec = this.db.prepare(`
        INSERT INTO purchase_recommendations (
          business_id, product_id, recommended_qty, cost_cents, priority_rank, rationale_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const pr of prioritizedResults) {
        if (pr.recommendedQty > 0) {
          insertRec.run(
            businessId,
            pr.productId,
            pr.recommendedQty,
            pr.costCents,
            pr.priorityRank,
            JSON.stringify(pr.evidence),
            pr.status
          );
        }
      }
    });

    saveTx();

    return {
      businessId,
      budget: {
        operatingCashCents,
        cashReserveCents,
        pendingApLeadWindowCents: pendingApCents,
        availableWorkingCapitalCents,
        allocatedBudgetCents: availableWorkingCapitalCents - remainingBudget,
        remainingWorkingCapitalCents: remainingBudget
      },
      recommendations: prioritizedResults
    };
  }

  /**
   * Lists persisted purchase recommendations with joined product details.
   */
  getStoredRecommendations(businessId) {
    const rows = this.db.prepare(`
      SELECT 
        pr.*,
        p.sku,
        p.name AS product_name,
        p.category,
        p.pack_size,
        p.lead_days,
        p.cost_price_cents,
        p.sell_price_cents
      FROM purchase_recommendations pr
      JOIN products p ON pr.product_id = p.id
      WHERE pr.business_id = ?
      ORDER BY pr.priority_rank ASC
    `).all(businessId);

    return rows.map((r) => {
      let parsedRationale = {};
      try {
        parsedRationale = JSON.parse(r.rationale_json);
      } catch (e) {}
      return {
        ...r,
        evidence: parsedRationale
      };
    });
  }
}

module.exports = ReorderEngine;
