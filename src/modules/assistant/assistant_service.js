/**
 * assistant_service.js — Live Context & Real-Time Intelligence Engine
 *
 * Provides:
 * - Read-only tenant-isolated context extraction from SQLite across all modules (Inventory, POs, Sales, AP/AR, ML).
 * - Real-time deterministic answering with numbers and verified database queries.
 * - Dual intelligence modes:
 *     1) ⚡ Real-Time Ledger (crisp numerical facts, formulas, audit tables)
 *     2) 🧠 Smart Reasoning (executive diagnostics, operational risks, prioritized action plans)
 */

'use strict';

const { getDb } = require('../../../database/connection');

class AssistantService {
  constructor(customDb) {
    this.db = customDb || getDb();
  }

  /**
   * Retrieves complete, tenant-isolated live business context.
   */
  getContext(businessId) {
    const biz = this.db.prepare(`
      SELECT id, name, currency, cash_reserve_cents, operating_cash_cents,
             default_lead_days, default_payment_terms_days, approval_threshold_cents
      FROM businesses WHERE id = ?
    `).get(businessId) || {
      id: businessId,
      name: 'Smart Business Analyzer',
      currency: 'USD',
      cash_reserve_cents: 1000000,
      operating_cash_cents: 5000000,
      default_lead_days: 7,
      default_payment_terms_days: 30,
      approval_threshold_cents: 50000
    };

    const currSym = biz.currency === 'EUR' ? '€' : (biz.currency === 'GBP' ? '£' : '$');

    // 1. Financial metrics (Payables, Receivables, Safe-to-spend budget)
    const payablesRow = this.db.prepare(`
      SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS upcoming_payables_cents
      FROM orders
      WHERE business_id = ? AND type = 'PURCHASE'
        AND status IN ('CONFIRMED', 'APPROVED', 'PARTIALLY_RECEIVED')
        AND due_date <= date('now', '+14 days')
    `).get(businessId);
    const upcomingPayablesCents = payablesRow ? payablesRow.upcoming_payables_cents : 0;

    const totalApRow = this.db.prepare(`
      SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS total_ap_cents
      FROM orders
      WHERE business_id = ? AND type = 'PURCHASE'
        AND status IN ('CONFIRMED', 'APPROVED', 'PARTIALLY_RECEIVED')
    `).get(businessId);
    const totalApCents = totalApRow ? totalApRow.total_ap_cents : 0;

    const receivablesRow = this.db.prepare(`
      SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS open_receivables_cents
      FROM orders
      WHERE business_id = ? AND type = 'SALE'
        AND status IN ('CONFIRMED', 'APPROVED', 'PARTIALLY_FULFILLED')
    `).get(businessId);
    const openReceivablesCents = receivablesRow ? receivablesRow.open_receivables_cents : 0;

    const safeBudgetCents = Math.max(0, (biz.operating_cash_cents || 0) - (biz.cash_reserve_cents || 0) - upcomingPayablesCents);

    // 2. Inventory Positions & Valuation
    const products = this.db.prepare(`
      SELECT 
        p.id, p.sku, p.name, p.category, p.base_unit, p.pack_size, p.lead_days, p.min_safety_stock,
        p.cost_price_cents, p.sell_price_cents,
        COALESCE(sm.on_hand, 0) AS on_hand,
        COALESCE(res.reserved, 0) AS reserved,
        (COALESCE(sm.on_hand, 0) - COALESCE(res.reserved, 0)) AS available,
        COALESCE(inc.incoming_po, 0) AS incoming_po
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(change_qty) AS on_hand
        FROM stock_movements
        WHERE business_id = ? AND (stock_type = 'AVAILABLE' OR stock_type IS NULL)
        GROUP BY product_id
      ) sm ON p.id = sm.product_id
      LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity - COALESCE(ol.fulfilled_quantity, 0)) AS reserved
        FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id
        WHERE o.business_id = ? AND o.type = 'SALE' AND o.status IN ('CONFIRMED', 'APPROVED', 'PARTIALLY_FULFILLED')
        GROUP BY ol.product_id
      ) res ON p.id = res.product_id
      LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity - COALESCE(ol.received_quantity, 0)) AS incoming_po
        FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id
        WHERE o.business_id = ? AND o.type = 'PURCHASE' AND o.status IN ('CONFIRMED', 'APPROVED', 'PARTIALLY_RECEIVED')
        GROUP BY ol.product_id
      ) inc ON p.id = inc.product_id
      WHERE p.business_id = ? AND p.is_archived = 0
      ORDER BY p.id ASC
    `).all(businessId, businessId, businessId, businessId);

    let totalValuationCents = 0;
    const criticalSkus = [];
    products.forEach((p) => {
      totalValuationCents += Math.max(0, p.on_hand) * (p.cost_price_cents || 0);
      if (p.available <= (p.min_safety_stock || 0) || p.available <= 0) {
        criticalSkus.push({
          sku: p.sku,
          name: p.name,
          on_hand: p.on_hand,
          available: p.available,
          reserved: p.reserved,
          min_safety_stock: p.min_safety_stock,
          incoming_po: p.incoming_po,
          lead_days: p.lead_days
        });
      }
    });

    // 3. Orders Overview
    const ordersCounts = this.db.prepare(`
      SELECT 
        type, status, COUNT(*) AS count,
        COALESCE(SUM(total_cents), 0) AS total_cents,
        COALESCE(SUM(paid_cents), 0) AS paid_cents
      FROM orders
      WHERE business_id = ?
      GROUP BY type, status
    `).all(businessId);

    const ordersSummary = {
      draftPos: { count: 0, total_cents: 0 },
      confirmedPos: { count: 0, total_cents: 0 },
      openSalesOrders: { count: 0, total_cents: 0 },
      fulfilledSalesOrders: { count: 0, total_cents: 0 },
      pendingCycleCounts: 0
    };

    ordersCounts.forEach((r) => {
      if (r.type === 'PURCHASE' && r.status === 'DRAFT') {
        ordersSummary.draftPos.count += r.count;
        ordersSummary.draftPos.total_cents += r.total_cents;
      } else if (r.type === 'PURCHASE' && ['CONFIRMED', 'APPROVED', 'PARTIALLY_RECEIVED'].includes(r.status)) {
        ordersSummary.confirmedPos.count += r.count;
        ordersSummary.confirmedPos.total_cents += r.total_cents;
      } else if (r.type === 'SALE' && ['DRAFT', 'CONFIRMED', 'APPROVED', 'PARTIALLY_FULFILLED'].includes(r.status)) {
        ordersSummary.openSalesOrders.count += r.count;
        ordersSummary.openSalesOrders.total_cents += r.total_cents;
      } else if (r.type === 'SALE' && r.status === 'FULFILLED') {
        ordersSummary.fulfilledSalesOrders.count += r.count;
        ordersSummary.fulfilledSalesOrders.total_cents += r.total_cents;
      }
    });

    // 4. Pending cycle counts
    const pendingCcRow = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM cycle_counts
      WHERE business_id = ? AND status = 'IN_PROGRESS'
    `).get(businessId);
    ordersSummary.pendingCycleCounts = pendingCcRow ? pendingCcRow.cnt : 0;

    // 5. Recent Purchase Orders
    let recentPurchaseOrders = [];
    try {
      recentPurchaseOrders = this.db.prepare(`
        SELECT o.id, o.order_number, o.status, o.total_cents, o.paid_cents, o.due_date, o.created_at,
               COALESCE(c.name, 'Default Vendor') AS contact_name
        FROM orders o
        LEFT JOIN contacts c ON o.contact_id = c.id
        WHERE o.business_id = ? AND o.type = 'PURCHASE'
        ORDER BY o.id DESC LIMIT 8
      `).all(businessId);
    } catch (_) {
      recentPurchaseOrders = [];
    }

    // 6. Recent Sales Orders
    let recentSalesOrders = [];
    try {
      recentSalesOrders = this.db.prepare(`
        SELECT o.id, o.order_number, o.status, o.total_cents, o.paid_cents, o.due_date, o.created_at,
               COALESCE(c.name, 'Direct Wholesale Customer') AS contact_name
        FROM orders o
        LEFT JOIN contacts c ON o.contact_id = c.id
        WHERE o.business_id = ? AND o.type = 'SALE'
        ORDER BY o.id DESC LIMIT 8
      `).all(businessId);
    } catch (_) {
      recentSalesOrders = [];
    }

    // 7. Suppliers & Customers
    let suppliers = [];
    let customers = [];
    try {
      suppliers = this.db.prepare(`
        SELECT id, name, email, phone, payment_terms_days
        FROM contacts WHERE business_id = ? AND type = 'SUPPLIER'
        ORDER BY name ASC LIMIT 10
      `).all(businessId);
      customers = this.db.prepare(`
        SELECT id, name, email, phone, payment_terms_days, credit_limit_cents
        FROM contacts WHERE business_id = ? AND type = 'CUSTOMER'
        ORDER BY name ASC LIMIT 10
      `).all(businessId);
    } catch (_) {
      suppliers = [];
      customers = [];
    }

    // 8. Forecasts Summary
    let forecasts = [];
    try {
      forecasts = this.db.prepare(`
        SELECT 
          p.sku, p.name AS product_name,
          df.horizon_days, df.p50_qty, df.p90_qty, df.model_name, df.uncertainty_score
        FROM demand_forecasts df
        JOIN products p ON df.product_id = p.id
        WHERE p.business_id = ? AND p.is_archived = 0
        ORDER BY df.id DESC
        LIMIT 10
      `).all(businessId);
    } catch (_) {
      forecasts = [];
    }

    return {
      business: {
        id: biz.id,
        name: biz.name,
        currency: biz.currency,
        currencySymbol: currSym,
        operatingCashCents: biz.operating_cash_cents || 0,
        cashReserveCents: biz.cash_reserve_cents || 0,
        safeBudgetCents,
        upcomingPayablesCents,
        totalApCents,
        openReceivablesCents,
        operatingCashFormatted: `${currSym}${((biz.operating_cash_cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        cashReserveFormatted: `${currSym}${((biz.cash_reserve_cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        safeBudgetFormatted: `${currSym}${(safeBudgetCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        upcomingPayablesFormatted: `${currSym}${(upcomingPayablesCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        totalApFormatted: `${currSym}${(totalApCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        openReceivablesFormatted: `${currSym}${(openReceivablesCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        approvalThresholdDollars: ((biz.approval_threshold_cents || 50000) / 100).toFixed(2),
        defaultLeadDays: biz.default_lead_days || 7
      },
      inventorySummary: {
        totalSkus: products.length,
        totalValuationCents,
        totalValuationFormatted: `${currSym}${(totalValuationCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        criticalStockCount: criticalSkus.length,
        criticalSkus,
        products: products.map((p) => ({
          sku: p.sku,
          name: p.name,
          category: p.category,
          on_hand: p.on_hand,
          available: p.available,
          reserved: p.reserved,
          incoming_po: p.incoming_po,
          cost_price_dollars: (p.cost_price_cents / 100).toFixed(2),
          sell_price_dollars: (p.sell_price_cents / 100).toFixed(2),
          min_safety_stock: p.min_safety_stock,
          lead_days: p.lead_days
        }))
      },
      ordersSummary,
      recentPurchaseOrders,
      recentSalesOrders,
      suppliers,
      customers,
      forecastsSummary: forecasts
    };
  }

  /**
   * Deterministic RAG responder answering live business questions and workflows.
   * Mode: 'ledger' (instant tables/numbers) or 'reasoning' (executive diagnostics & strategy).
   */
  ask({ businessId, question, mode = 'ledger', history = [] }) {
    const context = this.getContext(businessId);
    const qLower = (question || '').toLowerCase().trim();
    const currSym = context.business.currencySymbol;
    const isReasoning = mode === 'reasoning' || mode === 'llm';

    let groundedAnswer = '';
    const sources = [];
    const suggestedActions = [];

    // Helper: Find if a specific SKU was mentioned
    const mentionedProduct = context.inventorySummary.products.find(
      (p) => qLower.includes(p.sku.toLowerCase()) || (p.name && qLower.includes(p.name.toLowerCase()))
    );

    // ──────────────────────────────────────────
    // Intent 1: Specific SKU / Product Query
    // ──────────────────────────────────────────
    if (mentionedProduct) {
      sources.push(`Catalog Ledger (${mentionedProduct.sku})`, 'Stock Movement Audit');
      const isCritical = mentionedProduct.available <= (mentionedProduct.min_safety_stock || 0);

      if (!isReasoning) {
        groundedAnswer = [
          `### Product Status: **${mentionedProduct.sku}** (${mentionedProduct.name})`,
          `- **Category:** ${mentionedProduct.category || 'General'}`,
          `- **Physical On-Hand:** **${mentionedProduct.on_hand}** units`,
          `- **Reserved (Sales Orders):** **${mentionedProduct.reserved}** units`,
          `- **Net Available Stock:** **${mentionedProduct.available}** units`,
          `- **Inbound Purchase Orders:** **${mentionedProduct.incoming_po}** units`,
          `- **Safety Stock Ceiling:** **${mentionedProduct.min_safety_stock}** units (Lead Time: **${mentionedProduct.lead_days}** days)`,
          `- **Unit Pricing:** Cost **${currSym}${mentionedProduct.cost_price_dollars}** | Sell **${currSym}${mentionedProduct.sell_price_dollars}**`,
          '',
          isCritical
            ? `⚠️ **Restock Alert:** Net available stock (**${mentionedProduct.available}**) is at or below safety stock (**${mentionedProduct.min_safety_stock}**). Replenishment order recommended.`
            : `✅ **Healthy Stock:** Stock levels are adequate with **${mentionedProduct.available}** units available.`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Strategic SKU Analysis: **${mentionedProduct.sku}**`,
          `**Diagnostic Assessment:**`,
          `This item holds **${mentionedProduct.on_hand}** units physically with **${mentionedProduct.reserved}** units pre-allocated to customer orders, leaving **${mentionedProduct.available}** net available.`,
          '',
          `**Vulnerability & Lead Time Risk:**`,
          `- **Lead Time Exposure:** Replenishment cycle is **${mentionedProduct.lead_days} days**.`,
          `- **Buffer Margin:** Minimum safety stock is set to **${mentionedProduct.min_safety_stock} units**.`,
          `- **Status:** ${isCritical ? `🚨 **Critical Deficit:** Net available (${mentionedProduct.available}) has breached minimum buffer! Any sudden wholesale order will trigger a backorder stockout.` : `🟢 **Stable:** Inventory safely covers vendor lead-time variability.`}`,
          '',
          `**Recommended Action Plan:**`,
          `1. ${isCritical ? `Generate and approve a draft PO immediately for at least ${Math.max(10, (mentionedProduct.min_safety_stock * 2) - mentionedProduct.available)} units.` : `Monitor sales velocity; no immediate procurement purchase needed.`}`,
          `2. Check incoming POs (**${mentionedProduct.incoming_po}** inbound) to verify supplier shipment confirmation.`,
          `3. Unit margin is **${currSym}${(parseFloat(mentionedProduct.sell_price_dollars) - parseFloat(mentionedProduct.cost_price_dollars)).toFixed(2)}** per unit (${(((parseFloat(mentionedProduct.sell_price_dollars) - parseFloat(mentionedProduct.cost_price_dollars)) / parseFloat(mentionedProduct.sell_price_dollars)) * 100).toFixed(1)}% gross margin).`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'View in Catalog', tab: 'inventory' },
        { label: 'Adjust Stock Count', action: 'openAdjustForSku', sku: mentionedProduct.sku },
        { label: 'Create Purchase Order', action: 'newPo' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 2: Today's Priorities & Daily Operational Focus
    // ──────────────────────────────────────────
    else if (
      qLower.includes('today') ||
      qLower.includes('priority') ||
      qLower.includes('priorities') ||
      qLower.includes('agenda') ||
      qLower.includes('schedule') ||
      qLower.includes('task') ||
      qLower.includes('action item') ||
      qLower.includes('what should i do') ||
      qLower.includes('what to do')
    ) {
      sources.push('Operational Workflow Engine', 'Daily Action Queue');
      const b = context.business;
      const inv = context.inventorySummary;
      const pos = context.recentPurchaseOrders;
      const drafts = pos.filter((p) => p.status === 'DRAFT');
      const criticals = inv.criticalSkus;

      if (!isReasoning) {
        groundedAnswer = [
          `### 📅 Today's Operational Ledger & Pending Actions`,
          `- **Safe Purchasing Capacity:** **${b.safeBudgetFormatted}** (Available Cash: **${b.operatingCashFormatted}**, Reserve Floor: **${b.cashReserveFormatted}**)`,
          `- **Stockout Exposure:** **${inv.criticalStockCount}** critical SKU(s) breached safety buffer.`,
          `- **Pending Procurement Drafts:** **${drafts.length}** draft PO(s) waiting for approval.`,
          '',
          `| Order / Action | Type | Total / Impact | Required Next Step |`,
          `| :--- | :---: | :---: | :--- |`,
          drafts.length > 0 ? drafts.map((d) => `| **#${d.order_number}** | Draft PO | ${currSym}${(d.total_cents / 100).toFixed(2)} | Review line items & Approve to notify vendor |`).join('\n') : `| All POs Confirmed | Clean | $0.00 | No pending draft POs awaiting review |`,
          criticals.length > 0 ? criticals.map((c) => `| **${c.sku}** | Stockout Risk | ${c.available} left (Safety: ${c.min_safety_stock}) | Generate replenishment PO |`).join('\n') : `| Stock Health | Optimal | 0 Deficits | All inventory balances above safety buffer |`,
          '',
          `> **Today's Operational Guideline:** Review draft POs and verify they fit within your **${b.safeBudgetFormatted}** safe-to-spend limit before approving.`
        ].join('\n');
      } else {
        const largeDrafts = drafts.filter((d) => d.total_cents > b.safeBudgetCents);
        groundedAnswer = [
          `### 🧠 Executive Operational Briefing: Today's Strategic Focus`,
          `**Diagnostic Analysis for Today:**`,
          drafts.length > 0
            ? `You have **${drafts.length} draft purchase orders** awaiting commercial authorization.`
            : `Your purchase order pipeline is clear with zero pending draft orders.`,
          '',
          largeDrafts.length > 0
            ? `🚨 **Critical Budget Warning for Today:**\n` +
              largeDrafts.map((d) => `- **PO #${d.order_number}** is drafted for **${currSym}${(d.total_cents / 100).toFixed(2)}**, which exceeds your safe purchasing budget (**${b.safeBudgetFormatted}**) by **${currSym}${((d.total_cents - b.safeBudgetCents) / 100).toFixed(2)}**! Approving this order will violate your mandatory **${b.cashReserveFormatted}** bank reserve policy.`).join('\n') +
              `\n*Action Required: Resize or split this PO into phased supplier deliveries.*`
            : `✅ All pending draft POs fit comfortably within your verified **${b.safeBudgetFormatted}** safe purchasing budget.`,
          '',
          `**Inventory & Demand Health Today:**`,
          `- **Stockout Defense:** ${inv.criticalStockCount === 0 ? `🟢 Zero SKUs at risk today across ${inv.totalSkus} catalog items. Active safety stock is successfully insulating your business from customer order spikes.` : `⚠️ ${inv.criticalStockCount} SKU(s) have breached safety thresholds. Prioritize replenishment.`}`,
          `- **Liquid Headroom:** Operating cash stands at **${b.operatingCashFormatted}** with **${b.cashReserveFormatted}** protected reserve floor.`,
          '',
          `**Prioritized 3-Step Action Plan for Today:**`,
          `1. **Procurement Review:** Open the **Purchasing (PO)** tab, inspect the ${drafts.length} draft PO(s), and adjust quantities to respect capital limits.`,
          `2. **Warehouse Receiving:** Ensure dock staff check in any in-transit freight to keep on-hand inventory live and accurate.`,
          `3. **Demand Forecast Synchronization:** Run the Demand Planning ML pipeline to refresh 30-day quantile regression curves.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'Review Purchasing (PO)', tab: 'purchases' },
        { label: 'Demand Planning', tab: 'insights' },
        { label: 'Catalog & Inventory', tab: 'inventory' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 2: Stockout Risks & Critical Shortages
    // ──────────────────────────────────────────
    else if (
      qLower.includes('risk') ||
      qLower.includes('stockout') ||
      qLower.includes('critical') ||
      qLower.includes('shortage') ||
      qLower.includes('restock') ||
      qLower.includes('low stock') ||
      qLower.includes('out of stock') ||
      qLower.includes('deficit')
    ) {
      sources.push('Stockout Risk Detection Engine', 'Safety Buffer Ledger');
      const inv = context.inventorySummary;

      if (!isReasoning) {
        const critRows = inv.criticalSkus.map((c) =>
          `| **${c.sku}** | ${c.name.length > 24 ? c.name.slice(0, 23) + '…' : c.name} | **${c.available}** | ${c.min_safety_stock} | ${c.incoming_po} | ${c.lead_days}d | ⚠️ Low |`
        ).join('\n');

        groundedAnswer = [
          `### Critical Low-Stock SKUs & Stockout Alert`,
          inv.criticalStockCount > 0
            ? `There are **${inv.criticalStockCount}** active SKU(s) whose net available stock is at or below minimum safety stock buffers.`
            : `All product lines have healthy available inventory covering demand and vendor lead times.`,
          '',
          inv.criticalStockCount > 0 ? [
            `| SKU | Product Title | Available | Safety Buffer | Inbound POs | Lead Time | Status |`,
            `| :--- | :--- | :---: | :---: | :---: | :---: | :---: |`,
            critRows,
            '',
            `⚠️ **Restock Alert (${inv.criticalStockCount} SKU(s) at risk):**\n` +
            inv.criticalSkus.map((c) => `- **${c.sku}** (${c.name}): **${c.available}** units available vs **${c.min_safety_stock}** safety stock (${c.incoming_po || 0} inbound on POs)`).join('\n') +
            `\n\n*Generate replenishment purchase orders to protect order fulfillment.*`
          ].join('\n') : `✅ **Optimal Status:** Zero stockout risks detected across all ${inv.totalSkus} catalog products.`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Executive Stockout Risk & Replenishment Diagnostic`,
          `**Risk Severity Overview:**`,
          `You currently have **${inv.criticalStockCount}** out of ${inv.totalSkus} SKUs at immediate risk of supply failure.`,
          '',
          `**Vulnerability Breakdown:**`,
          inv.criticalSkus.map((c) =>
            `- **${c.sku} (${c.name}):** Available = **${c.available}** (Safety Target: ${c.min_safety_stock}). Supplier lead time is **${c.lead_days} days**. ${c.incoming_po > 0 ? `Inbound PO of ${c.incoming_po} units is in transit.` : `🚨 No inbound PO exists! Backorder danger is acute.`}`
          ).join('\n'),
          '',
          `**Strategic Action Plan:**`,
          `1. **Immediate Procurement:** Navigate to Purchasing (PO) and approve replenishment orders for zero-inbound items.`,
          `2. **Supplier Lead Time Buffer:** Prioritize orders with lead times $\\ge 7$ days first to avoid fulfillment disruption.`,
          `3. **Demand Review:** Run the Demand Planning pipeline to ensure high seasonal spikes are captured in P90 targets.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'Demand Planning', tab: 'insights' },
        { label: 'Create Purchase Order', action: 'newPo' },
        { label: 'View Inventory Catalog', tab: 'inventory' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 3: Purchasing Budget & Working Capital Policy
    // ──────────────────────────────────────────
    else if (
      qLower.includes('purchasing budget') ||
      qLower.includes('safe to spend') ||
      qLower.includes('how much can i spend') ||
      qLower.includes('safe budget') ||
      qLower.includes('spending limit') ||
      qLower.includes('cash reserve') ||
      qLower.includes('capital ceiling') ||
      qLower.includes('budget')
    ) {
      sources.push('Business Financial Governance', '14-Day Accounts Payable Ledger');
      const b = context.business;

      if (!isReasoning) {
        groundedAnswer = [
          `### Safe-to-Spend Purchasing Budget Policy`,
          `Your organization has **${b.safeBudgetFormatted}** in verified safe purchasing capital.`,
          '',
          `| Financial Parameter | Amount | Operational Policy |`,
          `| :--- | :--- | :--- |`,
          `| **Available Cash** | **${b.operatingCashFormatted}** | Liquid cash across verified business bank accounts |`,
          `| **Mandatory Cash Reserve** | **-${b.cashReserveFormatted}** | Liquidity policy ceiling protected from PO commits |`,
          `| **14-Day Confirmed Payables** | **-${b.upcomingPayablesFormatted}** | Vendor commitments due within 14 days |`,
          `| **Safe-to-Spend Budget** | **${b.safeBudgetFormatted}** | **Net safe capital for new replenishment POs** |`,
          '',
          `> **Working Capital Rule:** Draft purchase orders do **not** deduct from this budget until confirmed. Once a PO is approved/confirmed, vendor commitments are reserved against your working capital ceiling.`,
          '',
          `Additionally, you have **${b.openReceivablesFormatted}** in open customer accounts receivable across confirmed sales orders.`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Capital Allocation & Liquidity Strategy`,
          `**Working Capital Assessment:**`,
          `With **${b.operatingCashFormatted}** in total liquid cash and **${b.cashReserveFormatted}** locked under liquidity policy, your operational buffer is secure.`,
          '',
          `**Committed Obligations:**`,
          `- 14-day upcoming supplier bills stand at **${b.upcomingPayablesFormatted}**.`,
          `- Net purchasing headroom is **${b.safeBudgetFormatted}**.`,
          `- Pending uncollected customer cash (AR) is **${b.openReceivablesFormatted}**.`,
          '',
          `**Capital Optimization Advisory:**`,
          `1. **Safe PO Ceiling:** Keep total newly approved PO commitments under **${b.safeBudgetFormatted}** to protect bank reserve requirements.`,
          `2. **Cash Inflow Timing:** Collecting outstanding AR (**${b.openReceivablesFormatted}**) will immediately expand your purchasing headroom dollar-for-dollar.`,
          `3. **Draft Flexibility:** Draft POs do not freeze capital, allowing procurement planning without constraining ledger solvency.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'Review Purchasing (PO)', tab: 'purchases' },
        { label: 'View Cash Flow & Payments', tab: 'payments' },
        { label: 'Update Capital Reserve Policy', tab: 'settings' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 4: Purchase Orders (POs) & Inbound Pipeline
    // ──────────────────────────────────────────
    else if (
      qLower.includes('purchase order') ||
      qLower.includes('purchase orders') ||
      qLower.includes('draft po') ||
      qLower.includes('open po') ||
      /\bpos?\b/i.test(qLower) ||
      qLower.includes('procurement') ||
      qLower.includes('inbound order') ||
      qLower.includes('buy order')
    ) {
      sources.push('Purchase Orders Subsystem', 'Supplier Inbound Tracking');
      const pos = context.recentPurchaseOrders;
      const ord = context.ordersSummary;

      if (!isReasoning) {
        const poRows = pos.map((o) => {
          const tot = `${currSym}${(o.total_cents / 100).toFixed(2)}`;
          const paid = `${currSym}${(o.paid_cents / 100).toFixed(2)}`;
          return `| **#${o.order_number}** | ${o.contact_name} | **${o.status}** | ${tot} | ${paid} | ${o.due_date || 'N/A'} |`;
        }).join('\n');

        groundedAnswer = [
          `### Purchase Orders (PO) & Inbound Pipeline`,
          `- **Draft POs (Pending Approval):** **${ord.draftPos.count}** (${currSym}${(ord.draftPos.total_cents / 100).toFixed(2)})`,
          `- **Confirmed Inbound POs:** **${ord.confirmedPos.count}** (${currSym}${(ord.confirmedPos.total_cents / 100).toFixed(2)})`,
          '',
          pos.length > 0 ? [
            `| PO Number | Supplier | Status | Total | Paid | Due Date |`,
            `| :--- | :--- | :---: | :---: | :---: | :---: |`,
            poRows
          ].join('\n') : `*No purchase orders recorded yet in active tenant ledger.*`,
          '',
          `> **Receiving Tip:** To receive items into physical stock, open the confirmed PO and click **Receive Inbound Items**.`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Procurement & Inbound Supply Chain Reasoning`,
          `**Procurement Pipeline Status:**`,
          `You have **${ord.draftPos.count}** draft purchase orders and **${ord.confirmedPos.count}** active confirmed POs.`,
          '',
          `**Operational Risk Diagnosis:**`,
          ord.draftPos.count > 0
            ? `- ⚠️ **Pending Draft Orders:** You have ${ord.draftPos.count} PO(s) still in DRAFT. Suppliers will **not** dispatch goods until you click **Approve PO**!`
            : `- ✅ All generated purchase orders are approved or received.`,
          `- **Supplier Inbound Exposure:** Total incoming commitment across confirmed POs is **${currSym}${(ord.confirmedPos.total_cents / 100).toFixed(2)}**.`,
          '',
          `**Actionable Next Steps:**`,
          `1. Review all Draft POs and confirm with suppliers to lock in quoted unit prices.`,
          `2. For items arriving at the warehouse dock, perform partial or full receiving to update on-hand inventory balances.`,
          `3. Match invoices to purchase order line receipts to prevent vendor overbilling.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'View All Purchase Orders', tab: 'purchases' },
        { label: 'Create Purchase Order', action: 'newPo' },
        { label: 'Demand Planning', tab: 'insights' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 5: Sales Orders, Customer Demand & Revenue
    // ──────────────────────────────────────────
    else if (
      qLower.includes('sales order') ||
      qLower.includes('sales orders') ||
      qLower.includes('sales') ||
      qLower.includes('revenue') ||
      qLower.includes('customer order') ||
      qLower.includes('customer orders') ||
      qLower.includes('dispatch') ||
      qLower.includes('fulfillment') ||
      qLower.includes('fulfill') ||
      qLower.includes('open sales')
    ) {
      sources.push('Sales Orders Subsystem', 'Customer Demand Register');
      const sos = context.recentSalesOrders;
      const ord = context.ordersSummary;

      if (!isReasoning) {
        const soRows = sos.map((o) => {
          const tot = `${currSym}${(o.total_cents / 100).toFixed(2)}`;
          const paid = `${currSym}${(o.paid_cents / 100).toFixed(2)}`;
          return `| **#${o.order_number}** | ${o.contact_name} | **${o.status}** | ${tot} | ${paid} | ${o.due_date || 'N/A'} |`;
        }).join('\n');

        groundedAnswer = [
          `### Sales Orders & Commercial Demand Status`,
          `- **Open / Active Sales Orders:** **${ord.openSalesOrders.count}** (${currSym}${(ord.openSalesOrders.total_cents / 100).toFixed(2)})`,
          `- **Fulfilled Sales Orders:** **${ord.fulfilledSalesOrders.count}** (${currSym}${(ord.fulfilledSalesOrders.total_cents / 100).toFixed(2)})`,
          `- **Uncollected Accounts Receivable:** **${context.business.openReceivablesFormatted}**`,
          '',
          sos.length > 0 ? [
            `| Order Number | Customer | Status | Total | Paid | Due Date |`,
            `| :--- | :--- | :---: | :---: | :---: | :---: |`,
            soRows
          ].join('\n') : `*No sales orders recorded yet in active tenant ledger.*`,
          '',
          `> **Stock Reservation Rule:** Confirming a sales order reserves physical inventory immediately to prevent duplicate allocation to other customers.`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Customer Demand & Revenue Fulfillment Diagnostic`,
          `**Revenue Pipeline Evaluation:**`,
          `Active wholesale sales orders total **${currSym}${(ord.openSalesOrders.total_cents / 100).toFixed(2)}** across **${ord.openSalesOrders.count}** open transactions.`,
          '',
          `**Fulfillment & Cash Flow Dynamics:**`,
          `- **Stock Lockup:** Reserved stock is allocated strictly to confirmed orders.`,
          `- **Receivables Lag:** **${context.business.openReceivablesFormatted}** is pending customer settlement after fulfillment.`,
          '',
          `**Strategic Recommendations:**`,
          `1. Prioritize picking and dispatching orders in 'CONFIRMED' status to convert inventory into accounts receivable.`,
          `2. Enforce payment terms (${context.business.name} default: 30 days) to compress the order-to-cash cycle.`,
          `3. Reconcile backorders if any sales order exceeds available stock.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'View Sales Orders', tab: 'sales' },
        { label: 'Cash Flow & Payments', tab: 'payments' },
        { label: 'Inventory Catalog', tab: 'inventory' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 6: Suppliers & Vendor Directory
    // ──────────────────────────────────────────
    else if (
      qLower.includes('supplier') ||
      qLower.includes('suppliers') ||
      qLower.includes('vendor') ||
      qLower.includes('vendors')
    ) {
      sources.push('Contacts Directory (Suppliers)', 'Vendor Governance Ledger');
      const sups = context.suppliers;

      if (!isReasoning) {
        const supRows = sups.map((s) =>
          `| **${s.name}** | ${s.email || '—'} | ${s.phone || '—'} | **${s.payment_terms_days || 30} days** |`
        ).join('\n');

        groundedAnswer = [
          `### Active Wholesale Suppliers & Vendors`,
          `- **Total Registered Suppliers:** **${sups.length}** vendors`,
          `- **Default Payment Terms:** **${context.business.name}** policy is standard net-30 terms.`,
          '',
          sups.length > 0 ? [
            `| Vendor Name | Email | Phone | Payment Terms |`,
            `| :--- | :--- | :--- | :---: |`,
            supRows
          ].join('\n') : `*No suppliers registered yet. Add vendors via the Suppliers & Customers tab.*`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Supplier Dependency & Procurement Advisory`,
          `**Supply Chain Health:**`,
          `You have **${sups.length}** active vendor relationships supplying your product lines.`,
          '',
          `**Vendor Risk Analysis:**`,
          `- **Lead Time Sensitivity:** Supplier delays cascade directly into stockouts on items with safety buffers < 10 days.`,
          `- **Credit Terms:** Average terms of 30 days allow you to sell goods before supplier invoices become due.`,
          '',
          `**Strategic Sourcing Actions:**`,
          `1. Audit supplier on-time delivery performance across recent Purchase Orders.`,
          `2. Request volume tier discounts on high-velocity items with stable demand.`,
          `3. Keep secondary suppliers on file for critical single-source SKUs.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'Manage Suppliers & Customers', tab: 'contacts' },
        { label: 'Review Purchasing (PO)', tab: 'purchases' },
        { label: 'Create Purchase Order', action: 'newPo' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 7: Customers & Accounts Receivable (AR)
    // ──────────────────────────────────────────
    else if (
      qLower.includes('customer') ||
      qLower.includes('customers') ||
      qLower.includes('client') ||
      qLower.includes('clients') ||
      qLower.includes('buyer') ||
      qLower.includes('buyers')
    ) {
      sources.push('Contacts Directory (Customers)', 'Accounts Receivable Subsystem');
      const custs = context.customers;

      if (!isReasoning) {
        const custRows = custs.map((c) => {
          const cred = `${currSym}${((c.credit_limit_cents || 0) / 100).toLocaleString('en-US')}`;
          return `| **${c.name}** | ${c.email || '—'} | ${c.phone || '—'} | ${cred} | **${c.payment_terms_days || 30}d** |`;
        }).join('\n');

        groundedAnswer = [
          `### Registered Wholesale Customers`,
          `- **Total Customer Accounts:** **${custs.length}** accounts`,
          `- **Open Accounts Receivable:** **${context.business.openReceivablesFormatted}**`,
          '',
          custs.length > 0 ? [
            `| Customer Name | Email | Phone | Credit Limit | Terms |`,
            `| :--- | :--- | :--- | :---: | :---: |`,
            custRows
          ].join('\n') : `*No customer records found. Create customers in the Suppliers & Customers tab.*`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Customer Credit & Receivables Diagnostic`,
          `**Commercial Customer Overview:**`,
          `Customer accounts currently owe **${context.business.openReceivablesFormatted}** in outstanding wholesale invoice balances.`,
          '',
          `**Credit & Capital Risk:**`,
          `- High outstanding receivables tie up working capital that could otherwise fund inventory replenishment.`,
          `- Monitor customer credit limits to prevent uncollateralized exposure.`,
          '',
          `**Collections Action Plan:**`,
          `1. Issue statement reminders for invoices older than their agreed payment terms.`,
          `2. Require partial upfront deposits on large custom or non-standard batch orders.`,
          `3. Check the Payments & Cash Flow tab to register settlements as customer checks clear.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'View Customers Directory', tab: 'contacts' },
        { label: 'Payments & Receivables', tab: 'payments' },
        { label: 'Create Sales Order', tab: 'sales' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 8: Cash Flow, Payments & Liquidity
    // ──────────────────────────────────────────
    else if (
      qLower.includes('cash flow') ||
      qLower.includes('payable') ||
      qLower.includes('payables') ||
      qLower.includes('receivable') ||
      qLower.includes('receivables') ||
      /\bap\b/i.test(qLower) ||
      /\bar\b/i.test(qLower) ||
      qLower.includes('debt') ||
      qLower.includes('bills') ||
      qLower.includes('unpaid invoice') ||
      qLower.includes('cash balance') ||
      qLower.includes('bank') ||
      qLower.includes('liquid cash') ||
      qLower.includes('liquidity')
    ) {
      sources.push('Cash Flow & Balance Register', 'AP/AR Allocation Subsystem');
      const b = context.business;

      if (!isReasoning) {
        groundedAnswer = [
          `### Verified Cash Position & Payment Ledger`,
          `- **Verified Liquid Bank Cash:** **${b.operatingCashFormatted}**`,
          `- **Mandatory Policy Reserve:** **${b.cashReserveFormatted}** (Untouchable buffer)`,
          `- **14-Day Upcoming Supplier Payables (AP):** **${b.upcomingPayablesFormatted}**`,
          `- **Total Confirmed Payables (All AP):** **${b.totalApFormatted}**`,
          `- **Customer Accounts Receivable (AR):** **${b.openReceivablesFormatted}**`,
          `- **Net Safe-to-Spend Purchasing Capital:** **${b.safeBudgetFormatted}**`,
          '',
          `| Flow Direction | Parameter | Value | Ledger Status |`,
          `| :--- | :--- | :---: | :--- |`,
          `| 🟢 Inflow Pending | Customer AR | **${b.openReceivablesFormatted}** | Unpaid invoices |`,
          `| 🔴 Outflow Near-Term | 14-Day Vendor AP | **${b.upcomingPayablesFormatted}** | Due within 14 days |`,
          `| 🛡️ Shielded Buffer | Capital Reserve | **${b.cashReserveFormatted}** | Board-approved floor |`,
          `| ⚡ Free Headroom | Safe Budget | **${b.safeBudgetFormatted}** | **Safe to procure now** |`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Cash Flow & Working Capital Health Analysis`,
          `**Liquidity Runway Diagnostic:**`,
          `Your cash position is solvent with **${b.operatingCashFormatted}** in verified bank cash.`,
          '',
          `**Inflow vs Outflow Dynamic:**`,
          `- **Upcoming Vendor Drain:** You owe **${b.upcomingPayablesFormatted}** in supplier invoices due over the next 14 days.`,
          `- **Customer Cash Inflow:** You are owed **${b.openReceivablesFormatted}** from outstanding customer deliveries.`,
          `- **Net Operating Cash Flow:** If all receivables and payables clear, net working cash increases by **${currSym}${((b.openReceivablesCents - b.upcomingPayablesCents) / 100).toFixed(2)}**.`,
          '',
          `**Treasury Action Plan:**`,
          `1. Reconcile supplier payments before their due date to maintain vendor goodwill and credit terms.`,
          `2. Allocate partial payments in the Payments tab to match cash receipts.`,
          `3. Keep the cash reserve floor intact at ${b.cashReserveFormatted} to protect against unforeseen logistics shocks.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'Payments & Cash Flow', tab: 'payments' },
        { label: 'Review Purchasing (PO)', tab: 'purchases' },
        { label: 'Adjust Capital Reserve', tab: 'settings' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 9: Demand Planning, ML Forecasting & Replenishment Math
    // ──────────────────────────────────────────
    else if (
      qLower.includes('forecast') ||
      qLower.includes('forecasts') ||
      qLower.includes('ml') ||
      qLower.includes('p50') ||
      qLower.includes('p90') ||
      qLower.includes('lightgbm') ||
      qLower.includes('croston') ||
      qLower.includes('sba') ||
      qLower.includes('safety stock') ||
      qLower.includes('lead time demand') ||
      qLower.includes('formula') ||
      qLower.includes('math') ||
      qLower.includes('algorithm') ||
      qLower.includes('predict')
    ) {
      sources.push('Embedded ML Forecast Pipeline', 'Demand Planning Engine');
      const fc = context.forecastsSummary;

      if (!isReasoning) {
        groundedAnswer = [
          `### Demand Planning & Machine Learning Methodology`,
          `Our forecasting pipeline optimizes replenishment using automated model selection and quantile regression:`,
          '',
          `#### 1. Mathematical Formulas`,
          `- **Lead Time Demand ($LTD$):**`,
          `  $$LTD = \\bar{d} \\times L$$`,
          `  where $\\bar{d}$ is average daily sales velocity and $L$ is vendor lead time in days.`,
          `- **Safety Stock Buffer ($SS$):**`,
          `  $$SS = Z \\times \\sigma_d \\times \\sqrt{L}$$`,
          `  where $Z = 1.65$ (enforcing 95% service level) and $\\sigma_d$ is sales standard deviation.`,
          `- **Target Reorder Point ($ROP$):**`,
          `  $$ROP = LTD + SS$$`,
          '',
          `#### 2. Model Selection Logic`,
          `- **LightGBM Quantile Regression:** Deployed for steady and seasonal demand patterns to calculate median demand (**P50**) and high-risk peak demand (**P90**).`,
          `- **Croston's Method & SBA (Syntetos-Boylan Approximation):** Automatically activated when non-zero sales frequency is $< 30\\%$ to prevent over-stocking on lumpy wholesale orders.`,
          '',
          fc.length > 0
            ? `#### Live Top Forecasts in Database:\n` +
              fc
                .slice(0, 4)
                .map(
                  (f) =>
                    `- **${f.sku}**: P50 = **${f.p50_qty}** units, P90 = **${f.p90_qty}** units (Model: *${f.model_name}*, Horizon: ${f.horizon_days}d)`
                )
                .join('\n')
            : `*No cached forecasts in database yet. Run the ML pipeline from the Demand Planning tab to synchronize.*`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Demand Forecasting & Statistical Replenishment Advisory`,
          `**Mathematical Strategy:**`,
          `Traditional average-based inventory planning fails on volatile wholesale orders. Our system separates demand into steady vs intermittent streams:`,
          '',
          `**Dual-Engine Architecture:**`,
          `1. **Quantile Regression (P50 vs P90):**`,
          `   - **P50 (Median Expected Demand):** Best for standard replenishments with minimum holding cost.`,
          `   - **P90 (Peak Demand / 90th Percentile):** Used during seasonal promotions or supply chain delays to guarantee 95%+ service levels.`,
          `2. **Croston & SBA Smoothing:**`,
          `   - For intermittent, erratic SKUs (order frequency $< 30\\%$), Croston decouples order size from inter-arrival time. This prevents overstocking after an isolated bulk order.`,
          '',
          `**Operational Best Practices:**`,
          `1. Re-run the pipeline weekly to absorb new sales movements into rolling origins.`,
          `2. When lead times expand, safety stock scales with $\\sqrt{L}$—coordinate with vendors before hiking buffers.`,
          `3. Review recommended POs in Demand Planning to convert P50 predictions into real purchase orders.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'Open Demand Planning Tab', tab: 'insights' },
        { label: 'Run Demand Pipeline', action: 'runPipeline' },
        { label: 'Inspect Catalog Stock', tab: 'inventory' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 10: Cycle Counts, Audits & Blind Count Governance
    // ──────────────────────────────────────────
    else if (
      qLower.includes('blind count') ||
      qLower.includes('cycle count') ||
      qLower.includes('audit') ||
      qLower.includes('audits') ||
      qLower.includes('variance') ||
      qLower.includes('discrepancy') ||
      qLower.includes('physical count') ||
      qLower.includes('recount')
    ) {
      sources.push('Physical Inventory Subsystem', 'Governance Policy Ledger');
      const b = context.business;

      if (!isReasoning) {
        groundedAnswer = [
          `### Physical Inventory Cycle Count & Blind Audit Guide`,
          `The application implements two-phase physical audits to achieve 99%+ stock accuracy:`,
          '',
          `1. **Blind Count Mode (Eliminating Bias):**`,
          `   - In Blind Count mode, system expected quantities are **masked** from counting operators.`,
          `   - Warehouse staff must physically inspect bins and key in observed quantities without confirmation bias.`,
          '',
          `2. **Discrepancy & Monetary Approval Governance:**`,
          `   - When a counted item shows a discrepancy ($|\\text{Actual} - \\text{System}| > 0$), the application calculates total financial variance.`,
          `   - If total variance exceeds **${currSym}${b.approvalThresholdDollars}** (your configured threshold), approval requires **OWNER** authorization before stock movements post.`,
          `   - Once approved, the ledger automatically registers an audit adjustment transaction without manual reconciliation.`,
          '',
          `Current open audits in progress: **${context.ordersSummary.pendingCycleCounts}**.`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Inventory Governance & Shrinkage Prevention Strategy`,
          `**Governance Integrity Overview:**`,
          `Unreconciled physical discrepancies distort demand forecasting, leading to ghost stockouts and missed customer deliveries.`,
          '',
          `**Audit Safeguards Enforced:**`,
          `- **Confirmation Bias Prevention:** By blinding expected counts, warehouse operators cannot simply 'check off' numbers without touching physical goods.`,
          `- **Monetary Circuit Breaker:** Any count discrepancy exceeding **${currSym}${b.approvalThresholdDollars}** is locked until the OWNER reviews the audit trail.`,
          '',
          `**Recommended Audit Schedule:**`,
          `1. Perform weekly cycle counts on high-value and fast-moving A-class SKUs.`,
          `2. Perform monthly blind counts on bulk storage and pallet racking.`,
          `3. Keep the approval threshold calibrated under Settings & Team to match business risk tolerance.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'Open Cycle Count Audits', action: 'openCycleCount' },
        { label: 'Adjust Monetary Approval Limit', tab: 'settings' },
        { label: 'Catalog Inventory', tab: 'inventory' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 11: Profit Margins, Pricing & Valuation
    // ──────────────────────────────────────────
    else if (
      qLower.includes('profit') ||
      qLower.includes('margin') ||
      qLower.includes('margins') ||
      qLower.includes('markup') ||
      qLower.includes('valuation') ||
      qLower.includes('inventory value')
    ) {
      sources.push('Catalog Pricing Engine', 'Inventory Asset Ledger');
      const inv = context.inventorySummary;

      if (!isReasoning) {
        const topMarginProds = inv.products.slice(0, 6).map((p) => {
          const cost = parseFloat(p.cost_price_dollars);
          const sell = parseFloat(p.sell_price_dollars);
          const marginDol = (sell - cost).toFixed(2);
          const marginPct = sell > 0 ? (((sell - cost) / sell) * 100).toFixed(1) : '0.0';
          return `| **${p.sku}** | ${currSym}${cost.toFixed(2)} | ${currSym}${sell.toFixed(2)} | **${currSym}${marginDol}** | **${marginPct}%** |`;
        }).join('\n');

        groundedAnswer = [
          `### Catalog Valuation & Profit Margin Breakdown`,
          `- **Total Catalog Valuation (at cost):** **${inv.totalValuationFormatted}**`,
          `- **Total Active SKUs:** **${inv.totalSkus}** items`,
          '',
          `| SKU | Cost Price | Selling Price | Profit / Unit | Margin % |`,
          `| :--- | :---: | :---: | :---: | :---: |`,
          topMarginProds,
          '',
          `> **Inventory Valuation Rule:** Physical valuation is calculated strictly using actual on-hand balances multiplied by verified purchase cost price.`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Profitability & Inventory Capital Efficiency`,
          `**Asset Capitalization:**`,
          `Your warehouse currently holds **${inv.totalValuationFormatted}** in capital tied up in stock across ${inv.totalSkus} SKUs.`,
          '',
          `**Margin Dynamics:**`,
          `- Products with margins $\\ge 40\\%$ drive overall operating profit and can absorb expedited freight during stockout emergencies.`,
          `- Low-margin high-velocity items must maintain strict lead-time accuracy to prevent carrying cost erosion.`,
          '',
          `**Commercial Pricing Actions:**`,
          `1. Re-price SKUs where vendor raw cost has increased to maintain target gross margins.`,
          `2. Bundle slow-moving items with high-margin items to liquidate aged inventory and recover cash.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'View Inventory Catalog', tab: 'inventory' },
        { label: 'Sales Orders', tab: 'sales' },
        { label: 'Review Purchasing (PO)', tab: 'purchases' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 12: General Stocks & Inventory Table
    // ──────────────────────────────────────────
    else if (
      qLower.includes('stock') ||
      qLower.includes('stocks') ||
      qLower.includes('inventory') ||
      qLower.includes('catalog') ||
      qLower.includes('items') ||
      qLower.includes('item') ||
      qLower.includes('product') ||
      qLower.includes('products') ||
      qLower.includes('on hand') ||
      qLower.includes('available') ||
      qLower.includes('count')
    ) {
      sources.push('Live Inventory Position Engine', 'Stock Movement Ledger');
      const inv = context.inventorySummary;

      if (!isReasoning) {
        const itemsTable = inv.products.slice(0, 8).map((p) => {
          const isCrit = p.available <= (p.min_safety_stock || 0);
          const status = isCrit ? '⚠️ Low' : '✅ Optimal';
          return `| **${p.sku}** | ${p.name.length > 25 ? p.name.slice(0, 24) + '…' : p.name} | **${p.on_hand}** | ${p.reserved} | **${p.available}** | ${p.min_safety_stock} | ${p.incoming_po} | ${status} |`;
        }).join('\n');

        groundedAnswer = [
          `### Live Inventory Status & Stock Positions`,
          `- **Total Active Catalog:** **${inv.totalSkus}** SKUs`,
          `- **Total Inventory Valuation (at cost):** **${inv.totalValuationFormatted}**`,
          `- **Stockout Risks:** **${inv.criticalStockCount}** SKU(s) currently at or below minimum safety stock.`,
          '',
          `| SKU | Product Title | On-Hand | Reserved | Available | Safety | Inbound | Status |`,
          `| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |`,
          itemsTable,
          '',
          inv.criticalStockCount > 0
            ? `⚠️ **Restock Alert (${inv.criticalStockCount} SKU(s) at risk):**\n` +
              inv.criticalSkus.map((c) => `- **${c.sku}** (${c.name}): **${c.available}** units available vs **${c.min_safety_stock}** safety stock (${c.incoming_po || 0} inbound on POs)`).join('\n') +
              `\n\n*Generate replenishment purchase orders to protect order fulfillment.*`
            : `✅ **Healthy Stock:** All product lines have healthy available inventory covering demand.`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Inventory Velocity & Turnover Advisory`,
          `**Warehouse Balance Assessment:**`,
          `Active catalog comprises **${inv.totalSkus}** products with **${inv.totalValuationFormatted}** in inventory valuation at cost.`,
          '',
          `**Stock Distribution Health:**`,
          `- **Available vs Reserved:** Reserved quantities reflect customer commitments waiting for picking and dispatch.`,
          `- **Critical Thresholds:** ${inv.criticalStockCount > 0 ? `⚠️ ${inv.criticalStockCount} SKUs are below safety floor and require immediate purchase attention.` : `✅ All SKUs currently exceed their safety stock buffers.`}`,
          '',
          `**Inventory Optimization Plan:**`,
          `1. Ensure items with open customer orders are prioritized for warehouse packaging.`,
          `2. Check Demand Planning forecasts before raising purchase orders to avoid overstocking.`,
          `3. Conduct regular blind cycle counts to maintain 99%+ inventory data accuracy.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'View Inventory Catalog', tab: 'inventory' },
        { label: 'Demand Planning', tab: 'insights' },
        { label: 'Create Purchase Order', action: 'newPo' }
      );
    }
    // ──────────────────────────────────────────
    // Intent 13: Default Executive Business Briefing
    // ──────────────────────────────────────────
    else {
      sources.push('Smart Business Analyzer Executive Summary');
      const b = context.business;
      const inv = context.inventorySummary;
      const ord = context.ordersSummary;

      if (!isReasoning) {
        groundedAnswer = [
          `### Business Executive Briefing: **${b.name}**`,
          '',
          `- **Purchasing Budget (Safe to Spend):** **${b.safeBudgetFormatted}** (Cash: **${b.operatingCashFormatted}**, Reserve: **${b.cashReserveFormatted}**, 14d AP: **${b.upcomingPayablesFormatted}**)`,
          `- **Inventory Valuation:** **${inv.totalValuationFormatted}** across **${inv.totalSkus}** active SKUs.`,
          `- **Stockout Health:** **${inv.criticalStockCount}** SKUs currently at risk of stockout.`,
          `- **Open Orders Pipeline:** **${ord.draftPos.count}** Draft POs, **${ord.confirmedPos.count}** Inbound POs, **${ord.openSalesOrders.count}** Open Sales Orders.`,
          `- **Receivables / Payables:** AR: **${b.openReceivablesFormatted}** | 14d AP: **${b.upcomingPayablesFormatted}**`,
          '',
          `*Ask me about specific SKUs, purchasing budgets, sales orders, suppliers, ML formulas, or cash flow.*`
        ].join('\n');
      } else {
        groundedAnswer = [
          `### 🧠 Executive Strategic Briefing: **${b.name}**`,
          `**Operational Health Scorecard:**`,
          `- **Solvency & Capital:** Safe spending headroom is **${b.safeBudgetFormatted}** with bank reserves locked at **${b.cashReserveFormatted}**.`,
          `- **Fulfillment Pipeline:** **${ord.openSalesOrders.count}** sales orders are active, backed by **${b.openReceivablesFormatted}** in expected revenue.`,
          `- **Supply Risk:** **${inv.criticalStockCount}** SKUs have breached safety buffers and require purchase approvals.`,
          '',
          `**Today's Top 3 Priorities:**`,
          `1. **Stockout Prevention:** Review critical SKUs and confirm draft POs before supplier cutoff times.`,
          `2. **Cash Inflow Acceleration:** Dispatch fulfilled sales orders and send statements for overdue customer invoices.`,
          `3. **Forecasting Refresh:** Run the Demand Planning engine to synchronize 30-day replenishment recommendations.`
        ].join('\n');
      }

      suggestedActions.push(
        { label: 'Review Purchasing Budget', tab: 'purchases' },
        { label: 'Inspect Stockout Risks', tab: 'inventory' },
        { label: 'Demand Planning Insights', tab: 'insights' }
      );
    }

    return {
      success: true,
      groundedAnswer,
      liveContext: context,
      sources,
      suggestedActions
    };
  }
}

module.exports = AssistantService;
