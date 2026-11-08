/**
 * app.js — Frontend Application Engine for Smart Business Manager
 * Zoho Inventory Operations + StockTrim Demand Forecasting UX + Chart.js Visuals
 */

'use strict';

const App = (() => {
  // State store
  let state = {
    user: null,
    business: null,
    products: [],
    contacts: [],
    locations: [],
    orders: [],
    recommendations: [],
    metrics: null,
    financialSummary: null,
    currentTab: 'overview',
    searchQuery: '',
    selectedRecommendation: null,
    contactsFilterType: 'ALL'
  };

  // Chart instances cache
  let urgentChartInstance = null;
  let drawerChartInstance = null;

  const $ = (id) => document.getElementById(id);

  // Formatting utilities
  const formatMoney = (cents) => {
    return '$' + ((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatDate = (isoStr) => {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const showToast = (message, type = 'success') => {
    const container = $('toastContainer');
    if (!container) return;
    let text = message;
    if (typeof text !== 'string' || text === 'true' || text === 'false' || !text.trim()) {
      text = type === 'error' ? 'An unexpected error occurred. Please check input values.' : 'Operation completed successfully.';
    }
    const toast = document.createElement('div');
    const bg = type === 'error' ? 'bg-rose-900 border-rose-700 text-rose-100' : 'bg-slate-900 border-slate-700 text-slate-100';
    toast.className = `px-4 py-3 rounded-lg border shadow-xl text-xs font-semibold flex items-center justify-between gap-3 pointer-events-auto transition-all transform duration-200 ${bg}`;
    toast.innerHTML = `<span>${text}</span><button onclick="this.parentElement.remove()" class="text-slate-400 hover:text-white text-sm">&times;</button>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 200);
    }, 4000);
  };

  const api = async (endpoint, options = {}) => {
    try {
      const res = await fetch(endpoint, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });
      let data = null;
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = { error: text || `HTTP ${res.status}` };
      }

      if (!res.ok) {
        let errMsg = `Request failed (${res.status})`;
        if (data) {
          if (typeof data.message === 'string' && data.message.trim()) {
            errMsg = data.message;
          } else if (typeof data.error === 'string' && data.error.trim()) {
            errMsg = data.error;
          } else if (data.code) {
            errMsg = `${data.code}: ${res.statusText || 'Action failed'}`;
          }
        }
        const error = new Error(errMsg);
        error.status = res.status;
        error.code = data?.code;
        error.data = data;
        if (!options.silent) {
          showToast(errMsg, 'error');
        }
        throw error;
      }
      return data;
    } catch (err) {
      if (!options.silent && !err.status) {
        showToast(err.message || 'An unexpected error occurred', 'error');
      }
      throw err;
    }
  };

  // ──────────────────────────────────────────
  // Navigation & Dropdown Controls
  // ──────────────────────────────────────────
  const initNavigation = () => {
    // Delegated click navigation so dynamically updated/rendered links always respond
    document.addEventListener('click', (e) => {
      const navBtn = e.target.closest('#sidebarNav .nav-link');
      if (navBtn) {
        const target = navBtn.dataset.tab;
        if (!target) return;
        document.querySelectorAll('#sidebarNav .nav-link').forEach((b) => b.classList.remove('active'));
        navBtn.classList.add('active');

        document.querySelectorAll('.view-panel').forEach((panel) => panel.classList.add('hidden'));
        const activePanel = $(`view-${target}`);
        if (activePanel) activePanel.classList.remove('hidden');
        state.currentTab = target;

        if (target === 'overview') loadOverviewData();
        if (target === 'inventory') loadInventory();
        if (target === 'purchases') loadPurchaseOrders();
        if (target === 'sales') loadSalesOrders();
        if (target === 'payments') loadPayments();
        if (target === 'insights') loadInsightsOverview();
        if (target === 'b2b') loadB2bData();
        if (target === 'settings') loadSettings();
        return;
      }

      // Close create dropdown menu on outside click
      const wrapper = $('createDropdownWrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        toggleCreateMenu(false);
      }
    });

    // Global keyboard shortcut '/' to focus search
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        const search = $('globalSearchInput');
        if (search) {
          search.focus();
          search.select();
        }
      }
    });

    // Global Search listener across all views
    const searchInput = $('globalSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.trim().toLowerCase();
        if (state.currentTab === 'overview') renderRecommendations();
        if (state.currentTab === 'inventory') renderInventoryTable();
        if (state.currentTab === 'purchases') renderOrdersTable('purchaseOrdersTableBody', 'PURCHASE');
        if (state.currentTab === 'sales') renderOrdersTable('salesOrdersTableBody', 'SALE');
        if (state.currentTab === 'insights') renderInsightsOverview();
      });
    }
  };

  const toggleCreateMenu = (forceState) => {
    const menu = $('createDropdownMenu');
    if (!menu) return;
    if (forceState !== undefined) {
      if (forceState) menu.classList.remove('hidden');
      else menu.classList.add('hidden');
    } else {
      menu.classList.toggle('hidden');
    }
  };

  // ──────────────────────────────────────────
  // Auth & Session Lifecycle
  // ──────────────────────────────────────────
  const checkAuth = async () => {
    try {
      let data = null;
      try {
        data = await api('/api/auth/me', { silent: true });
      } catch (authErr) {
        // If unauthenticated or 401, auto-authenticate demo guest session
        try {
          const guestRes = await api('/api/auth/guest', { method: 'POST', silent: true });
          if (guestRes && (guestRes.authenticated || guestRes.success)) {
            data = guestRes;
          }
        } catch (guestErr) {
          console.warn('Auto guest login attempt failed:', guestErr);
        }
      }

      if (!data || (!data.authenticated && !data.success)) {
        if (!window.location.pathname.includes('login')) {
          window.location.href = '/login';
        }
        return false;
      }
      state.user = data.user || {};
      state.business = data.business || {};

      const bizNameEl = $('sidebarBizName');
      if (bizNameEl) {
        let bName = data.business?.name || 'Smart Business Analyzer';
        if (bName.includes('Vanguard Wholesale') || bName.includes('Apex Wholesale')) {
          bName = 'Smart Business Analyzer';
        }
        bizNameEl.textContent = bName;
      }

      const badge = $('tenantModeBadge');
      if (badge) {
        const isGuest = Boolean(data.user?.isGuest || data.user?.email === 'guest@demo');
        if (isGuest) {
          badge.textContent = 'Demo Guest';
          badge.className = 'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200';
        } else {
          // Extract first name from email prefix or user name
          const emailPrefix = data.user?.email ? data.user.email.split('@')[0] : '';
          const rawName = data.user?.name && data.user.name !== 'Guest Operator' ? data.user.name : emailPrefix;
          const firstName = rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : (data.user?.role || 'Owner');
          badge.textContent = firstName;
          badge.className = 'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200';
        }
      }

      const userNameEl = $('userNameLabel');
      const userEmailEl = $('userEmailLabel');
      const userAvatar = $('userAvatar');
      const displayName = data.user?.name || (data.user?.isGuest ? 'Guest Operator' : (data.user?.email || 'Guest'));
      const displayEmail = data.user?.email || (data.user?.isGuest ? 'guest@demo' : '');
      if (userNameEl) userNameEl.textContent = displayName;
      if (userEmailEl) userEmailEl.textContent = displayEmail;
      if (userAvatar) userAvatar.textContent = (displayName[0] || 'G').toUpperCase();

      updateOnboardingProgress();
      return true;
    } catch (err) {
      console.error('checkAuth failure:', err);
      if (!window.location.pathname.includes('login')) {
        window.location.href = '/login';
      }
      return false;
    }
  };

  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', silent: true });
    } finally {
      window.location.href = '/login';
    }
  };

  // ──────────────────────────────────────────
  // Initial Data Loaders
  // ──────────────────────────────────────────
  const loadInitialData = async () => {
    try {
      const isAuthed = await checkAuth();
      if (!isAuthed) return;

      const [metrics, recs, positions, contacts, locs] = await Promise.all([
        api('/api/overview', { silent: true })
          .catch(() => api('/api/metrics', { silent: true }))
          .catch(() => null),
        api('/api/intelligence/recommendations', { silent: true }).catch(() => []),
        api('/api/products', { silent: true })
          .catch(() => api('/api/inventory/positions', { silent: true }))
          .catch(() => []),
        api('/api/contacts', { silent: true }).catch(() => []),
        api('/api/inventory/locations', { silent: true }).catch(() => [])
      ]);

      state.metrics = metrics || {
        freeWorkingCapitalCents: 0,
        cashReserveCents: 0,
        inventoryAssetValueCents: 0,
        stockoutRiskCount: 0,
        topReorderPriorities: []
      };
      state.recommendations = Array.isArray(recs) ? recs : (recs?.recommendations || []);
      state.products = Array.isArray(positions) ? positions : (positions?.positions || []);
      state.contacts = Array.isArray(contacts) ? contacts : [];
      state.locations = Array.isArray(locs) ? locs : [];

      updateHeaderAndKpis();
      renderUrgentReorderChart();
      renderRecommendations();
      populateSelectOptions();
    } catch (err) {
      console.error('Error loading initial data:', err);
    }
  };

  const loadOverviewData = async () => {
    try {
      const [metrics, recs, positions] = await Promise.all([
        api('/api/overview', { silent: true })
          .catch(() => api('/api/metrics', { silent: true }))
          .catch(() => null),
        api('/api/intelligence/recommendations', { silent: true }).catch(() => []),
        api('/api/products', { silent: true })
          .catch(() => api('/api/inventory/positions', { silent: true }))
          .catch(() => [])
      ]);
      if (metrics) state.metrics = metrics;
      state.recommendations = Array.isArray(recs) ? recs : (recs?.recommendations || []);
      state.products = Array.isArray(positions) ? positions : (positions?.positions || []);
      updateHeaderAndKpis();
      renderUrgentReorderChart();
      renderRecommendations();
    } catch (err) {
      console.error('Error loading overview data:', err);
    }
  };

  const updateHeaderAndKpis = () => {
    const m = state.metrics;
    if (!m) return;

    const budgetCents = m.purchasingBudgetCents ?? m.purchasing_budget_cents ?? m.workingCapitalAvailableCents ?? m.freeWorkingCapitalCents ?? 0;

    // Header Working Capital Pills
    if ($('headerFreeCapital')) $('headerFreeCapital').textContent = formatMoney(budgetCents);
    if ($('headerCashReserve')) $('headerCashReserve').textContent = formatMoney(m.cashReserveCents || 0);

    // 1. Capital & Health Strip (4 Executive Indicators)
    if ($('kpiPurchasingBudget')) $('kpiPurchasingBudget').textContent = formatMoney(budgetCents);
    if ($('kpiWorkingCapitalAvail')) $('kpiWorkingCapitalAvail').textContent = formatMoney(budgetCents);
    if ($('kpiUpcomingDebt')) $('kpiUpcomingDebt').textContent = formatMoney(m.upcomingAp14dCents || 0);
    if ($('kpiCashReserve')) $('kpiCashReserve').textContent = formatMoney(m.cashReserveCents || 0);

    if ($('kpiInventoryAssetValue')) {
      $('kpiInventoryAssetValue').textContent = formatMoney(m.inventoryAssetValueCents || 0);
    }

    if ($('kpiStockoutRiskCount')) {
      $('kpiStockoutRiskCount').textContent = `${m.stockoutRiskCount || 0} SKUs`;
      if ($('kpiStockoutRiskBadge')) {
        $('kpiStockoutRiskBadge').className = (m.stockoutRiskCount > 0)
          ? 'text-rose-700 bg-rose-50 px-2 py-0.5 rounded text-[10px] font-bold'
          : 'text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded text-[10px] font-bold';
        $('kpiStockoutRiskBadge').textContent = (m.stockoutRiskCount > 0) ? 'Action Required' : 'Optimal';
      }
    }

    renderTodaysActions(m.todaysActions);
  };

  const renderTodaysActions = (actions) => {
    const container = $('todaysActionsContainer');
    const badge = $('todaysActionsCountBadge');
    if (!container) return;

    let items = Array.isArray(actions) && actions.length > 0 ? actions : [];

    // Synthesize active actions if not pre-seeded by server
    if (items.length === 0) {
      // 1. High urgency reorders
      const urgentRec = (state.recommendations || []).find((r) => r.status !== 'ORDERED' && (r.urgency === 'CRITICAL' || r.cover_days < 7));
      if (urgentRec) {
        items.push({
          id: 'action-reorder-' + urgentRec.id,
          priority: 'HIGH',
          type: 'REORDER',
          title: `Restock ${urgentRec.sku}`,
          description: `Stock covers only ${urgentRec.cover_days || 4} days. Reorder ${urgentRec.recommended_qty} units.`,
          action_text: 'Review Reorder',
          target_id: urgentRec.id,
          link_tab: 'overview'
        });
      }

      // 2. Pending purchase orders to receive
      const confirmedPo = (state.orders || []).find((o) => o.type === 'PURCHASE' && o.status === 'CONFIRMED');
      if (confirmedPo) {
        items.push({
          id: 'action-receive-' + confirmedPo.id,
          priority: 'MEDIUM',
          type: 'RECEIVE_PO',
          title: `Receive PO #${confirmedPo.order_number}`,
          description: `Supplier shipment ready for receiving and inventory check-in.`,
          action_text: 'Receive Stock',
          target_id: confirmedPo.id,
          link_tab: 'purchases'
        });
      }

      // 3. Unpaid supplier bills
      const unpaidPo = (state.orders || []).find((o) => o.type === 'PURCHASE' && o.status !== 'CANCELLED' && o.paid_cents < o.total_cents);
      if (unpaidPo) {
        items.push({
          id: 'action-pay-' + unpaidPo.id,
          priority: 'MEDIUM',
          type: 'PAYMENT',
          title: `Vendor Payment Due`,
          description: `Unpaid balance of ${formatMoney(unpaidPo.total_cents - unpaidPo.paid_cents)} on PO #${unpaidPo.order_number}.`,
          action_text: 'Pay Bill',
          target_id: unpaidPo.id,
          link_tab: 'payments'
        });
      }

      // 4. Cycle count audit
      items.push({
        id: 'action-cycle-count',
        priority: 'MEDIUM',
        type: 'CYCLE_COUNT',
        title: 'Weekly Cycle Count Audit',
        description: 'Verify warehouse inventory accuracy and reconcile variances.',
        action_text: 'Start Audit',
        target_id: null,
        link_tab: 'inventory'
      });
    }

    if (badge) badge.textContent = `${items.length} Tasks`;

    container.innerHTML = items.map((item) => {
      const isHigh = item.priority === 'HIGH';
      return `
        <div class="p-3.5 rounded-xl border ${isHigh ? 'border-rose-200 bg-rose-50/40' : 'border-slate-200 bg-slate-50'} flex flex-col justify-between transition hover:shadow-xs">
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <span class="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${isHigh ? 'bg-rose-100 text-rose-800' : 'bg-slate-200 text-slate-700'}">
                ${item.priority} Priority
              </span>
            </div>
            <h4 class="text-xs font-bold text-slate-900">${item.title}</h4>
            <p class="text-[11px] text-slate-600 mt-1 line-clamp-2">${item.description}</p>
          </div>
          <div class="mt-3 pt-2.5 border-t ${isHigh ? 'border-rose-100' : 'border-slate-200'} flex justify-end">
            <button onclick="App.handleTodayAction('${item.type}', ${item.target_id ? item.target_id : 'null'}, '${item.link_tab || ''}')"
              class="px-3 py-1.5 rounded-lg text-xs font-semibold ${isHigh ? 'bg-rose-600 hover:bg-rose-700 text-white' : 'bg-indigo-600 hover:bg-indigo-700 text-white'} transition shadow-2xs">
              ${item.action_text || 'Take Action'} →
            </button>
          </div>
        </div>
      `;
    }).join('');
  };

  const handleTodayAction = (type, targetId, linkTab) => {
    if (type === 'REORDER' && targetId) {
      openDrawer(targetId);
    } else if (type === 'RECEIVE_PO' && targetId) {
      openReceivePoModal(targetId);
    } else if (type === 'PAYMENT' && targetId) {
      openPaymentModal();
    } else if (type === 'CYCLE_COUNT') {
      openCycleCountModal();
    } else if (linkTab) {
      switchTab(linkTab);
    }
  };

  // ──────────────────────────────────────────
  // Overview Chart.js: Top 5 Urgent Reorder Priorities
  // ──────────────────────────────────────────
  const renderUrgentReorderChart = () => {
    const canvas = $('urgentReorderChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const priorities = state.metrics?.topReorderPriorities || [];
    if (!priorities || priorities.length === 0) {
      if (urgentChartInstance) {
        urgentChartInstance.destroy();
        urgentChartInstance = null;
      }
      const existing = Chart.getChart(canvas);
      if (existing) existing.destroy();
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const labels = priorities.map((p) => {
      const name = p?.name || p?.product_name || p?.sku || 'Item';
      const sku = p?.sku || 'SKU';
      return `${sku} (${name.length > 18 ? name.slice(0, 18) + '…' : name})`;
    });
    const currentStockData = priorities.map((p) => p?.currentStock ?? p?.available ?? 0);
    const reorderPointData = priorities.map((p) => p?.reorderPoint ?? p?.reorder_point ?? 0);

    if (urgentChartInstance) {
      urgentChartInstance.destroy();
      urgentChartInstance = null;
    }
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();

    urgentChartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Current Available Stock',
            data: currentStockData,
            backgroundColor: '#4f46e5',
            borderRadius: 4,
            barThickness: 12
          },
          {
            label: 'Reorder Point Target',
            data: reorderPointData,
            backgroundColor: '#f59e0b',
            borderRadius: 4,
            barThickness: 12
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: { boxWidth: 12, font: { size: 10, family: 'Inter' } }
          },
          tooltip: {
            callbacks: {
              afterBody: (items) => {
                const idx = items[0]?.dataIndex;
                const p = priorities[idx];
                if (!p) return '';
                return `Cover Days: ${p.coverDays ?? 0}d\nRecommended Reorder: ${p.recommendedQty ?? 0} units`;
              }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: '#f1f5f9' },
            ticks: { font: { size: 10, family: 'Inter' } }
          },
          y: {
            grid: { display: false },
            ticks: { font: { size: 10, family: 'Inter', weight: '500' } }
          }
        },
        onClick: (_e, elements) => {
          if (elements && elements.length > 0) {
            const idx = elements[0].index;
            const clickedSku = priorities[idx]?.sku;
            const rec = (state.recommendations || []).find((r) => r.sku === clickedSku);
            if (rec) openDrawer(rec.id);
          }
        }
      }
    });
  };

  // ──────────────────────────────────────────
  // StockTrim Replenishment Table
  // ──────────────────────────────────────────
  const renderRecommendations = () => {
    const tbody = $('recommendationsTableBody');
    const badge = $('recsCountBadge');
    if (!tbody) return;

    let recs = state.recommendations || [];
    if (state.searchQuery) {
      const q = state.searchQuery;
      recs = recs.filter((r) => r.sku.toLowerCase().includes(q) || (r.name || r.product_name || '').toLowerCase().includes(q));
    }

    if (badge) badge.textContent = `${recs.length} SKUs`;

    if (recs.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="py-12 text-center text-slate-400">
            No purchase recommendations required. All SKU inventory cover levels are optimal.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = recs.map((r) => {
      const why = r.evidence?.why || {};
      const coverDays = why.current_cover_days !== undefined ? why.current_cover_days : 0;
      const leadDays = r.lead_days || why.lead_time_days || 7;
      const available = why.available_stock !== undefined ? why.available_stock : 0;
      const onHand = r.on_hand !== undefined ? r.on_hand : available;
      const incoming = why.incoming_po !== undefined ? why.incoming_po : 0;
      const velocity = why.daily_demand_velocity !== undefined ? why.daily_demand_velocity : 0;
      const packs = r.packsToOrder || Math.ceil((r.recommended_qty || 0) / (r.pack_size || 1));
      const packSize = r.pack_size || 1;

      // Status indicator bar
      const ratio = leadDays > 0 ? (coverDays / (leadDays * 2)) : 0;
      const barPercent = Math.min(100, Math.max(8, Math.round(ratio * 100)));
      let statusColor = 'bg-emerald-500 text-emerald-700';
      let urgencyBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Stable</span>';

      if (coverDays < 7 || coverDays < leadDays) {
        statusColor = 'bg-rose-500 text-rose-700';
        urgencyBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">Critical</span>';
      } else if (coverDays <= 14 || coverDays < leadDays * 1.5) {
        statusColor = 'bg-amber-500 text-amber-700';
        urgencyBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">Warning</span>';
      }

      const isOrdered = r.status === 'ORDERED';
      const orderRef = r.generated_order_number || `PO-${r.id}`;

      return `
        <tr class="hover:bg-slate-50/80 cursor-pointer transition-colors group" onclick="App.openDrawer(${r.id})">
          <td class="py-3 px-4 text-center font-bold text-slate-500">
            #${r.priority_rank || 1}
          </td>
          <td class="py-3 px-4">
            <div class="font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">${r.sku}</div>
            <div class="text-[11px] text-slate-500 truncate max-w-xs">${r.name || r.product_name}</div>
          </td>
          <td class="py-3 px-4">
            <div class="flex items-center justify-between text-[11px] mb-1">
              <span class="font-semibold text-slate-700">${coverDays}d cover</span>
              <span class="text-slate-400 font-medium">${leadDays}d lead</span>
            </div>
            <div class="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
              <div class="${statusColor.split(' ')[0]} h-1.5 rounded-full" style="width: ${barPercent}%"></div>
            </div>
          </td>
          <td class="py-3 px-4">
            <div class="font-medium text-slate-800">${available} avail</div>
            <div class="text-[11px] text-slate-400">${incoming} on order</div>
          </td>
          <td class="py-3 px-4 text-right font-medium text-slate-700">
            ${velocity.toFixed(1)} /day
          </td>
          <td class="py-3 px-4 text-right">
            <div class="font-bold text-slate-900">${r.recommended_qty} units</div>
            <div class="text-[11px] text-slate-400">${packs} packs &times; ${packSize}</div>
          </td>
          <td class="py-3 px-4 text-right font-bold text-slate-900">
            ${formatMoney(r.cost_cents)}
          </td>
          <td class="py-3 px-4 text-center">
            ${urgencyBadge}
          </td>
          <td class="py-3 px-4 text-right" onclick="event.stopPropagation()">
            ${isOrdered ? `
              <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                ✓ Draft PO Created
              </span>
            ` : `
              <button id="recBtn-${r.id}" onclick="App.generateDraftPo(${r.id}, event)"
                class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-600 hover:text-white border border-indigo-200 hover:border-indigo-600 transition-colors">
                <span>Draft PO</span>
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/>
                </svg>
              </button>
            `}
          </td>
        </tr>
      `;
    }).join('');
  };

  // ──────────────────────────────────────────
  // Sliding Right-Hand Drawer (Chart.js Demand Forecast)
  // ──────────────────────────────────────────
  const openDrawer = async (recommendationId) => {
    let rec = (state.recommendations || []).find((r) => r.id === recommendationId);
    if (!rec) {
      // Find by product_id
      rec = (state.recommendations || []).find((r) => r.product_id === recommendationId);
    }
    if (!rec) {
      // Build dummy recommendation object for inspecting non-reorder products
      const p = state.products.find((prod) => prod.product_id === recommendationId || prod.id === recommendationId);
      if (p) {
        rec = {
          id: p.product_id,
          product_id: p.product_id,
          sku: p.sku,
          name: p.name,
          category: p.category,
          lead_days: p.lead_days,
          pack_size: p.pack_size,
          cost_price_cents: p.cost_price_cents,
          recommended_qty: 0,
          cost_cents: 0,
          status: 'STABLE',
          evidence: {
            why: {
              daily_demand_velocity: 0,
              current_cover_days: p.available > 0 ? 30 : 0,
              available_stock: p.available,
              incoming_po: p.incoming_po,
              safety_stock_units: p.min_safety_stock
            }
          }
        };
      }
    }
    if (!rec) return;

    state.selectedRecommendation = rec;

    // Header info
    if ($('drawerSkuBadge')) $('drawerSkuBadge').textContent = rec.sku;
    if ($('drawerCategory')) $('drawerCategory').textContent = rec.category || 'General Catalog';
    if ($('drawerTitle')) $('drawerTitle').textContent = rec.name || rec.product_name;

    const why = rec.evidence?.why || {};
    const what = rec.evidence?.what_to_buy || {};
    const coverDays = why.current_cover_days !== undefined ? why.current_cover_days : (rec.cover_days || 0);

    // High-Contrast Health Pill (🔴 Critical <7d | 🟡 Warning 7-14d | 🟢 Healthy >14d)
    const healthPill = $('drawerHealthPill');
    if (healthPill) {
      if (coverDays < 7) {
        healthPill.className = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-300';
        healthPill.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-rose-600 mr-1.5"></span> Critical (&lt;7d cover)';
      } else if (coverDays <= 14) {
        healthPill.className = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300';
        healthPill.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-amber-600 mr-1.5"></span> Warning (7-14d cover)';
      } else {
        healthPill.className = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300';
        healthPill.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-600 mr-1.5"></span> Healthy (&gt;14d cover)';
      }
    }

    const leadDays = rec.lead_days || why.lead_time_days || 7;
    const velocity = why.daily_demand_velocity !== undefined ? why.daily_demand_velocity : 0;
    const leadDemand = why.lead_demand_forecast !== undefined ? why.lead_demand_forecast : Math.round(velocity * leadDays);
    const safetyStock = why.safety_stock_units !== undefined ? why.safety_stock_units : 0;
    const available = why.available_stock !== undefined ? why.available_stock : 0;
    const incoming = why.incoming_po !== undefined ? why.incoming_po : 0;
    const netDeficit = Math.max(0, (leadDemand + safetyStock) - available - incoming);
    const packs = rec.packsToOrder || what.packs_count || Math.ceil((rec.recommended_qty || 0) / (rec.pack_size || 1));
    const packSize = rec.pack_size || what.pack_size || 1;

    // Human-Readable Summary Cards
    if ($('cardSalesVelocity')) $('cardSalesVelocity').textContent = `${velocity.toFixed(1)} units / day`;
    if ($('cardLeadTime')) $('cardLeadTime').textContent = `${leadDays} days`;
    if ($('cardSafetyBuffer')) $('cardSafetyBuffer').textContent = `Buffer required: ${safetyStock} units`;
    if ($('cardOrderNeeded')) $('cardOrderNeeded').textContent = `Order Needed: ${packs} packs`;
    if ($('cardStockPositionSub')) $('cardStockPositionSub').textContent = `Current: ${available} units | Incoming: ${incoming} units`;

    // Detailed Metrics List (Double-Negative Bug Fixed: handles negative available cleanly)
    if ($('drawerLeadDays')) $('drawerLeadDays').textContent = leadDays;
    if ($('drawerLeadDemand')) $('drawerLeadDemand').textContent = `${leadDemand} units`;
    if ($('drawerSafetyStock')) $('drawerSafetyStock').textContent = `${safetyStock} units`;
    
    // Resolve double-negative: - -25 units -> -25 units (Deficit)
    if ($('drawerAvailable')) {
      if (available < 0) {
        $('drawerAvailable').textContent = `${available} units (Deficit)`;
        $('drawerAvailable').className = 'font-semibold text-rose-600';
      } else {
        $('drawerAvailable').textContent = `${available} units`;
        $('drawerAvailable').className = 'font-semibold text-slate-800';
      }
    }

    if ($('drawerIncoming')) $('drawerIncoming').textContent = `${incoming} units`;
    if ($('drawerNetRequirement')) $('drawerNetRequirement').textContent = `${netDeficit} units`;
    if ($('drawerPackSnapped')) $('drawerPackSnapped').textContent = `${packs} packs (${rec.recommended_qty} units)`;

    // Procurement Specs & Structured Explainability
    if ($('drawerPackSize')) $('drawerPackSize').textContent = `${packSize} units/pack`;
    if ($('drawerUnitCost')) $('drawerUnitCost').textContent = formatMoney(rec.cost_price_cents || what.unit_cost_cents);
    if ($('drawerLeadTime')) $('drawerLeadTime').textContent = `${leadDays} calendar days`;
    if ($('drawerTotalCost')) $('drawerTotalCost').textContent = formatMoney(rec.cost_cents || what.total_cost_cents);
    if ($('drawerCommitmentPrice')) $('drawerCommitmentPrice').textContent = formatMoney(rec.cost_cents || what.total_cost_cents);

    if ($('drawerTargetReorder')) $('drawerTargetReorder').textContent = `${packs} packs (${rec.recommended_qty} units)`;
    if ($('drawerTargetCost')) $('drawerTargetCost').textContent = formatMoney(rec.cost_cents || what.total_cost_cents);
    if ($('drawerUnitCostLabel')) $('drawerUnitCostLabel').textContent = `at ${formatMoney(rec.cost_price_cents || what.unit_cost_cents)} / unit`;
    if ($('drawerDriverSummary')) $('drawerDriverSummary').textContent = coverDays < leadDays ? 'Critical: cover < lead time' : 'Buffer & replenishment target';
    if ($('drawerDemandPattern')) $('drawerDemandPattern').textContent = rec.evidence?.uncertainty?.demand_pattern || 'Smooth';
    if ($('drawerConfidence')) $('drawerConfidence').textContent = rec.evidence?.uncertainty?.confidence_interval || 'High (90%)';
    if ($('drawerP50Qty')) $('drawerP50Qty').textContent = `${rec.evidence?.uncertainty?.p50_horizon_demand ?? Math.round(velocity * 14)} units`;
    if ($('drawerP90Qty')) $('drawerP90Qty').textContent = `${rec.evidence?.uncertainty?.p90_horizon_demand ?? Math.round(velocity * 14 * 1.4)} units`;

    // Setup action button
    const poBtn = $('drawerDraftPoBtn');
    if (poBtn) {
      if (rec.status === 'ORDERED') {
        const orderNum = rec.generated_order_number || `PO-${rec.id}`;
        poBtn.disabled = true;
        poBtn.className = 'px-5 py-2.5 rounded-lg bg-emerald-100 text-emerald-800 border border-emerald-300 font-semibold text-xs cursor-default flex items-center gap-1.5';
        poBtn.innerHTML = `<span>✓ Draft PO #${orderNum} Created</span>`;
      } else if (rec.recommended_qty <= 0) {
        poBtn.disabled = true;
        poBtn.className = 'px-5 py-2.5 rounded-lg bg-slate-100 text-slate-400 font-semibold text-xs cursor-not-allowed';
        poBtn.innerHTML = '<span>Stock Level Optimal</span>';
      } else {
        poBtn.disabled = false;
        poBtn.className = 'px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs transition shadow-sm flex items-center gap-2';
        poBtn.innerHTML = `
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <span>Generate Draft PO (${packs} packs • ${formatMoney(rec.cost_cents)})</span>
        `;
      }
    }

    // Render Chart.js Forecast
    renderDrawerForecastChart(rec);

    // Slide in drawer
    const drawer = $('recommendationDrawer');
    const overlay = $('drawerOverlay');
    if (drawer && overlay) {
      overlay.classList.remove('hidden');
      setTimeout(() => {
        overlay.classList.remove('opacity-0');
        drawer.classList.remove('translate-x-full');
      }, 10);
    }
  };

  const closeDrawer = () => {
    const drawer = $('recommendationDrawer');
    const overlay = $('drawerOverlay');
    if (drawer && overlay) {
      drawer.classList.add('translate-x-full');
      overlay.classList.add('opacity-0');
      setTimeout(() => {
        overlay.classList.add('hidden');
      }, 300);
    }
  };

  // ──────────────────────────────────────────
  // Chart.js Interactive Forecast (Past 30d + Today + Next 14d)
  // ──────────────────────────────────────────
  const renderDrawerForecastChart = async (rec) => {
    const canvas = $('drawerForecastChart');
    if (!canvas || typeof Chart === 'undefined') return;

    // Immediately destroy any active chart instance to prevent stale graph caching
    if (drawerChartInstance) {
      drawerChartInstance.destroy();
      drawerChartInstance = null;
    }
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();

    try {
      const prodId = rec.product_id || rec.id;
      const data = await api(`/api/intelligence/forecasts/${prodId}`);
      if (!data) return;

      // Use modular view controller if loaded
      if (typeof ForecastsView !== 'undefined' && ForecastsView.renderForecastChart) {
        drawerChartInstance = ForecastsView.renderForecastChart(canvas, data);
        return;
      }

      const history = (data.history || []).slice(-30);
      const futureDaily = data.forecast?.futureDaily || [];
      const p50Daily = data.forecast?.p50Daily || (data.forecast?.p50Qty ? data.forecast.p50Qty / 14 : 5);
      const p90Daily = data.forecast?.p90Daily || (p50Daily * 1.5);

      const labels = [];
      const pastData = [];
      const p50Data = [];
      const p90Data = [];

      // Past 30 Days (reading actual salesQty / quantity)
      history.forEach((h) => {
        const d = new Date(h.date || h.day);
        labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        const val = h.salesQty !== undefined ? h.salesQty : (h.quantity !== undefined ? h.quantity : (h.adjustedDemand || 0));
        pastData.push(val);
        p50Data.push(null);
        p90Data.push(null);
      });

      // Today junction point
      const todayVal = pastData.length > 0 ? (pastData[pastData.length - 1] || 0) : 0;
      labels.push('Today');
      pastData.push(todayVal);
      p50Data.push(todayVal);
      p90Data.push(todayVal);

      // Future 14 Days (distinct SKU predicted curve)
      for (let i = 1; i <= 14; i++) {
        labels.push(`+${i}d`);
        pastData.push(null);

        if (futureDaily.length >= i) {
          p50Data.push(futureDaily[i - 1].p50);
          p90Data.push(futureDaily[i - 1].p90);
        } else {
          const futureDate = new Date(Date.now() + i * 86400000);
          const dow = futureDate.getDay();
          const dowFactor = (dow >= 2 && dow <= 5) ? 1.25 : (dow === 1 ? 1.0 : 0.65);
          const dynamicP50 = parseFloat((p50Daily * dowFactor).toFixed(1));
          p50Data.push(dynamicP50);
          p90Data.push(parseFloat((dynamicP50 * 1.35).toFixed(1)));
        }
      }

      const todayIndex = history.length;

      // Custom plugin: Vertical dashed divider line at "Today"
      const todayDividerPlugin = {
        id: 'todayDivider',
        beforeDraw: (chart) => {
          const { ctx, chartArea, scales: { x } } = chart;
          const xPos = x.getPixelForValue(todayIndex);
          if (xPos) {
            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 1.5;
            ctx.moveTo(xPos, chartArea.top);
            ctx.lineTo(xPos, chartArea.bottom);
            ctx.stroke();

            // Label
            ctx.fillStyle = '#64748b';
            ctx.font = '10px Inter';
            ctx.textAlign = 'center';
            ctx.fillText('TODAY', xPos, chartArea.top - 4);
            ctx.restore();
          }
        }
      };

      drawerChartInstance = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Historical Sales',
              data: pastData,
              borderColor: '#4f46e5',
              backgroundColor: '#4f46e5',
              borderWidth: 2,
              pointRadius: 2,
              pointHoverRadius: 4,
              tension: 0.2
            },
            {
              label: 'P50 Expected Demand',
              data: p50Data,
              borderColor: '#10b981',
              backgroundColor: '#10b981',
              borderWidth: 2,
              borderDash: [5, 5],
              pointRadius: 2,
              pointHoverRadius: 4,
              tension: 0.1
            },
            {
              label: 'P90 Peak Scenario',
              data: p90Data,
              borderColor: '#059669',
              borderWidth: 1,
              borderDash: [2, 2],
              backgroundColor: 'rgba(16, 185, 129, 0.15)',
              fill: '-1', // Fill down to P50 dataset
              pointRadius: 0,
              tension: 0.1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { maxTicksLimit: 12, font: { size: 9, family: 'Inter' } }
            },
            y: {
              beginAtZero: true,
              grid: { color: '#f1f5f9' },
              ticks: { font: { size: 9, family: 'Inter' } }
            }
          }
        },
        plugins: [todayDividerPlugin]
      });
    } catch (err) {
      console.error('Drawer chart error:', err);
    }
  };

  const generatePoFromDrawer = async () => {
    if (!state.selectedRecommendation) return;
    await generateDraftPo(state.selectedRecommendation.id);
  };

  const generateDraftPo = async (recId, event) => {
    if (event) event.stopPropagation();

    try {
      const rec = state.recommendations.find((r) => r.id === recId) || state.selectedRecommendation;
      const res = await api(`/api/intelligence/recommendations/${recId}/create-po`, {
        method: 'POST',
        body: JSON.stringify({
          estimated_cost_cents: rec?.cost_cents || rec?.evidence?.what_to_buy?.total_cost_cents
        })
      });

      const orderNumber = res.orderNumber || res.order?.order_number || `PO-${Date.now().toString().slice(-5)}`;
      showToast(`Draft Purchase Order #${orderNumber} created successfully!`, 'success');

      // Update state
      if (rec) {
        rec.status = 'ORDERED';
        rec.generated_order_number = orderNumber;
      }

      // Update table row button state to green disabled badge
      const tableBtn = $(`recBtn-${recId}`);
      if (tableBtn) {
        tableBtn.outerHTML = `
          <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
            ✓ Draft PO Created
          </span>
        `;
      }

      // Update drawer button
      const drawerBtn = $('drawerDraftPoBtn');
      if (drawerBtn) {
        drawerBtn.disabled = true;
        drawerBtn.className = 'px-5 py-2.5 rounded-lg bg-emerald-100 text-emerald-800 border border-emerald-300 font-semibold text-xs cursor-default flex items-center gap-1.5';
        drawerBtn.innerHTML = `<span>✓ Draft PO Created</span>`;
      }

      renderRecommendations();
      loadOverviewData();
    } catch (err) {
      console.error(err);
    }
  };

  const recomputeIntelligence = async () => {
    try {
      showToast('Running demand forecast pipeline…', 'info');
      const res = await api('/api/intelligence/run-pipeline', { method: 'POST' });
      if (res && res.success) {
        showToast('Demand forecasting pipeline completed successfully!', 'success');
      } else if (res && !res.success) {
        // Fall back gracefully to internal recommendations recompute
        console.warn('Python pipeline notice:', res.error);
        const fallbackRes = await api('/api/intelligence/recommendations/recompute', { method: 'POST' });
        if (fallbackRes && fallbackRes.success) {
          showToast('Forecasting synchronized via embedded ML engine!', 'success');
        } else {
          showToast(`Pipeline: ${res.error || 'Execution failed'}`, 'error');
        }
      }

      // Re-fetch forecasts and overview data dynamically
      await Promise.all([
        api('/api/intelligence/forecasts'),
        loadOverviewData(),
        loadInventory()
      ]);

      if (state.currentTab === 'insights') {
        await loadInsightsOverview();
      }

      // Live Drawer Sync: If drawer is currently open, dynamically update without page refresh
      if (state.selectedRecommendation) {
        const prodId = state.selectedRecommendation.product_id || state.selectedRecommendation.id;
        openDrawer(prodId);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const seedBenchmarkData = async () => {
    try {
      showToast('Provisioning benchmark dataset (45 days, 3 distinct patterns)…', 'info');
      const res = await api('/api/intelligence/seed-benchmark-data', { method: 'POST' });
      if (res && res.success) {
        showToast('Benchmark test dataset seeded successfully!', 'success');
        await Promise.all([
          loadOverviewData(),
          loadInventory(),
          api('/api/intelligence/forecasts')
        ]);
        if (state.currentTab === 'insights') {
          await loadInsightsOverview();
        }
        if (state.selectedRecommendation) {
          const prodId = state.selectedRecommendation.product_id || state.selectedRecommendation.id;
          openDrawer(prodId);
        }
      } else {
        showToast(`Seeding failed: ${res?.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ──────────────────────────────────────────
  // Catalog & Inventory Views (Full CRUD)
  // ──────────────────────────────────────────
  const loadInventory = async () => {
    try {
      const [positions, movements] = await Promise.all([
        api('/api/inventory/positions'),
        api('/api/inventory/movements?limit=30')
      ]);
      state.products = positions || [];
      renderInventoryTable();
      renderMovementsTable(movements || []);
    } catch (err) {
      console.error(err);
    }
  };

  let activeCatalogFilter = 'all';

  const filterCatalog = (filter) => {
    activeCatalogFilter = filter;
    ['all', 'active', 'low', 'slow', 'archived'].forEach((f) => {
      const btn = $(`catFilter-${f}`);
      if (btn) {
        if (f === filter) {
          btn.className = 'px-3 py-1 rounded-md text-xs font-semibold bg-indigo-600 text-white shadow-2xs';
        } else {
          btn.className = 'px-3 py-1 rounded-md text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100';
        }
      }
    });
    renderInventoryTable();
  };

  const renderInventoryTable = () => {
    const tbody = $('inventoryTableBody');
    if (!tbody) return;

    let items = state.products || [];

    // Filter tab handling
    if (activeCatalogFilter === 'active') {
      items = items.filter((i) => !i.is_archived && i.on_hand > 0);
    } else if (activeCatalogFilter === 'low') {
      items = items.filter((i) => !i.is_archived && i.on_hand <= i.min_safety_stock);
    } else if (activeCatalogFilter === 'slow') {
      items = items.filter((i) => !i.is_archived && (i.lead_days >= 10 || i.on_hand > i.min_safety_stock * 2));
    } else if (activeCatalogFilter === 'archived') {
      items = items.filter((i) => Boolean(i.is_archived));
    } else {
      // 'all' excludes archived items by default
      items = items.filter((i) => !i.is_archived);
    }

    if (state.searchQuery) {
      const q = state.searchQuery;
      items = items.filter((i) => i.sku.toLowerCase().includes(q) || (i.name || '').toLowerCase().includes(q));
    }

    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="py-12 text-center text-slate-400">No products found for the selected filter or search.</td></tr>';
      return;
    }

    tbody.innerHTML = items.map((p) => {
      const isLow = p.on_hand <= p.min_safety_stock;
      const isArchived = Boolean(p.is_archived);
      return `
        <tr class="hover:bg-slate-50 transition-colors group">
          <td class="py-3 px-4 sticky left-0 bg-white group-hover:bg-slate-50 z-10">
            <span class="font-bold text-slate-900">${p.sku}</span>
            <div class="text-[10px] text-slate-400 font-mono">${p.barcode || '—'}</div>
          </td>
          <td class="py-3 px-4 font-semibold text-slate-800">${p.name}</td>
          <td class="py-3 px-4 text-slate-500">${p.category}</td>
          <td class="py-3 px-4 text-right text-slate-700">${formatMoney(p.cost_price_cents)}</td>
          <td class="py-3 px-4 text-right font-medium text-slate-800">${formatMoney(p.sell_price_cents)}</td>
          <td class="py-3 px-4 text-right font-bold text-slate-900">${p.on_hand} ${p.base_unit}</td>
          <td class="py-3 px-4 text-right font-semibold text-slate-800">${p.available}</td>
          <td class="py-3 px-4 text-right text-indigo-600 font-semibold">${p.incoming_po}</td>
          <td class="py-3 px-4 text-center">
            ${isArchived ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-300">Archived</span>' :
              (isLow ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">Low Stock</span>'
                     : '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Normal</span>')}
          </td>
          <td class="py-3 px-4 text-right sticky right-0 bg-white group-hover:bg-slate-50 z-10">
            <div class="inline-flex items-center gap-1.5">
              ${isArchived ? `
                <button onclick="App.unarchiveProduct(${p.product_id})" class="px-2.5 py-1 rounded text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition">
                  Restore
                </button>
              ` : `
                <button onclick="App.openDrawerForProduct(${p.product_id})" class="px-2 py-1 rounded text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition">
                  Inspect
                </button>
                <button onclick="App.openEditProductModal(${p.product_id})" class="px-2 py-1 rounded text-[11px] font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition">
                  Edit
                </button>
                <button onclick="App.deleteProduct(${p.product_id}, '${p.sku}')" title="Archive SKU preserving order & movement history" class="px-2 py-1 rounded text-[11px] font-semibold bg-rose-50 hover:bg-rose-100 text-rose-700 transition">
                  Archive
                </button>
              `}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  };

  const renderMovementsTable = (movements) => {
    const tbody = $('movementsTableBody');
    if (!tbody) return;

    if (movements.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400">No stock movements recorded yet.</td></tr>';
      return;
    }

    tbody.innerHTML = movements.map((m) => `
      <tr class="hover:bg-slate-50 transition-colors">
        <td class="py-2.5 px-4 text-slate-400 font-mono text-[11px]">${formatDate(m.created_at)}</td>
        <td class="py-2.5 px-4">
          <span class="font-bold text-slate-800">${m.sku}</span>
          <span class="text-[11px] text-slate-500 ml-1">(${m.product_name})</span>
        </td>
        <td class="py-2.5 px-4 text-slate-600">${m.location_name}</td>
        <td class="py-2.5 px-4 text-center font-bold ${m.change_qty > 0 ? 'text-emerald-600' : 'text-rose-600'}">
          ${m.change_qty > 0 ? '+' : ''}${m.change_qty}
        </td>
        <td class="py-2.5 px-4 text-right font-bold text-slate-900">${m.balance_after}</td>
        <td class="py-2.5 px-4 text-slate-600 text-[11px]">${m.reason}</td>
        <td class="py-2.5 px-4 text-slate-400 text-[10px] uppercase font-mono">${m.source_tag || 'MANUAL'}</td>
      </tr>
    `).join('');
  };

  // Product Edit Modal
  const openEditProductModal = (productId) => {
    const p = state.products.find((item) => item.product_id === productId || item.id === productId);
    if (!p) return;

    $('editProductId').value = p.product_id;
    $('editProductSku').value = p.sku;
    $('editProductBarcode').value = p.barcode || '';
    $('editProductName').value = p.name;
    $('editProductCategory').value = p.category || 'General';
    $('editProductUnit').value = p.base_unit || 'pcs';
    $('editProductPackSize').value = p.pack_size || 1;
    $('editProductLeadDays').value = p.lead_days || 7;
    $('editProductCostPrice').value = ((p.cost_price_cents || 0) / 100).toFixed(2);
    $('editProductSellPrice').value = ((p.sell_price_cents || 0) / 100).toFixed(2);
    $('editProductMinSafety').value = p.min_safety_stock || 10;

    openModal('editProductModal');
  };

  const submitEditProduct = async (e) => {
    e.preventDefault();
    const productId = $('editProductId').value;
    const payload = {
      sku: $('editProductSku').value.trim(),
      barcode: $('editProductBarcode').value.trim(),
      name: $('editProductName').value.trim(),
      category: $('editProductCategory').value.trim(),
      base_unit: $('editProductUnit').value.trim(),
      pack_size: parseInt($('editProductPackSize').value, 10),
      lead_days: parseInt($('editProductLeadDays').value, 10),
      cost_price_cents: Math.round(parseFloat($('editProductCostPrice').value || 0) * 100),
      sell_price_cents: Math.round(parseFloat($('editProductSellPrice').value || 0) * 100),
      min_safety_stock: parseInt($('editProductMinSafety').value, 10)
    };

    try {
      await api(`/api/inventory/products/${productId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast(`Product ${payload.sku} updated successfully!`, 'success');
      closeModal('editProductModal');
      loadInventory();
      loadOverviewData();
    } catch (err) {
      console.error(err);
    }
  };

  const deleteProduct = async (productId, sku) => {
    if (!confirm(`Are you sure you want to delete product ${sku}? This will remove its inventory movements and forecasts.`)) {
      return;
    }

    try {
      await api(`/api/inventory/products/${productId}`, { method: 'DELETE' });
      showToast(`Product ${sku} deleted.`, 'success');
      loadInventory();
      loadOverviewData();
    } catch (err) {
      console.error(err);
    }
  };

  // ──────────────────────────────────────────
  // Contacts Management (Suppliers & Customers CRUD)
  // ──────────────────────────────────────────
  const openContactsModal = async () => {
    await loadContactsList();
    openModal('contactsModal');
  };

  const loadContactsList = async () => {
    try {
      const contacts = await api('/api/contacts');
      state.contacts = contacts || [];
      renderContactsModalTable();
    } catch (err) {
      console.error(err);
    }
  };

  const filterContactsTab = (type) => {
    state.contactsFilterType = type;
    ['ALL', 'SUPPLIER', 'CUSTOMER'].forEach((t) => {
      const el = $(`contactTab${t === 'ALL' ? 'All' : (t === 'SUPPLIER' ? 'Suppliers' : 'Customers')}`);
      if (el) {
        if (t === type) el.className = 'px-3 py-1 rounded-md text-xs font-semibold bg-indigo-600 text-white';
        else el.className = 'px-3 py-1 rounded-md text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100';
      }
    });
    renderContactsModalTable();
  };

  const renderContactsModalTable = () => {
    const tbody = $('contactsModalTableBody');
    if (!tbody) return;

    let list = state.contacts || [];
    if (state.contactsFilterType !== 'ALL') {
      list = list.filter((c) => c.type === state.contactsFilterType);
    }

    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-400">No contacts found.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map((c) => `
      <tr class="hover:bg-slate-50 transition-colors">
        <td class="py-2.5 px-3 font-bold text-slate-900">${c.name}</td>
        <td class="py-2.5 px-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${c.type === 'SUPPLIER' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-blue-50 text-blue-700 border border-blue-200'}">
            ${c.type}
          </span>
        </td>
        <td class="py-2.5 px-3 text-slate-600">${c.email || '—'}</td>
        <td class="py-2.5 px-3 text-slate-600">${c.payment_terms_days} days</td>
        <td class="py-2.5 px-3 text-right font-semibold text-slate-800">${formatMoney(c.credit_limit_cents)}</td>
        <td class="py-2.5 px-3 text-right">
          <button onclick="App.openEditContactForm(${c.id})" class="text-xs font-semibold text-indigo-600 hover:text-indigo-800 mr-2">Edit</button>
          <button onclick="App.deleteContact(${c.id}, '${c.name}')" class="text-xs font-semibold text-rose-600 hover:text-rose-800">Delete</button>
        </td>
      </tr>
    `).join('');
  };

  const openNewContactForm = () => {
    $('contactFormModalTitle').textContent = 'Create Business Contact';
    $('contactFormId').value = '';
    $('contactFormType').value = 'SUPPLIER';
    $('contactFormName').value = '';
    $('contactFormEmail').value = '';
    $('contactFormPhone').value = '';
    $('contactFormTerms').value = '30';
    $('contactFormCredit').value = '0';
    openModal('contactFormModal');
  };

  const openEditContactForm = (contactId) => {
    const c = state.contacts.find((item) => item.id === contactId);
    if (!c) return;

    $('contactFormModalTitle').textContent = `Edit Contact: ${c.name}`;
    $('contactFormId').value = c.id;
    $('contactFormType').value = c.type;
    $('contactFormName').value = c.name;
    $('contactFormEmail').value = c.email || '';
    $('contactFormPhone').value = c.phone || '';
    $('contactFormTerms').value = c.payment_terms_days || 30;
    $('contactFormCredit').value = ((c.credit_limit_cents || 0) / 100).toFixed(0);
    openModal('contactFormModal');
  };

  const submitContactForm = async (e) => {
    e.preventDefault();
    const contactId = $('contactFormId').value;
    const isEdit = Boolean(contactId);

    const payload = {
      type: $('contactFormType').value,
      name: $('contactFormName').value.trim(),
      email: $('contactFormEmail').value.trim(),
      phone: $('contactFormPhone').value.trim(),
      payment_terms_days: parseInt($('contactFormTerms').value, 10) || 30,
      credit_limit_cents: Math.round((parseFloat($('contactFormCredit').value) || 0) * 100)
    };

    try {
      if (isEdit) {
        await api(`/api/contacts/${contactId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        showToast('Contact updated successfully!', 'success');
      } else {
        await api('/api/contacts', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        showToast('Contact created successfully!', 'success');
      }
      closeModal('contactFormModal');
      await loadContactsList();
      populateSelectOptions();
    } catch (err) {
      console.error(err);
    }
  };

  const deleteContact = async (contactId, name) => {
    if (!confirm(`Are you sure you want to delete ${name}?`)) return;

    try {
      await api(`/api/contacts/${contactId}`, { method: 'DELETE' });
      showToast(`Contact ${name} deleted.`, 'success');
      await loadContactsList();
      populateSelectOptions();
    } catch (err) {
      console.error(err);
    }
  };

  // ──────────────────────────────────────────
  // Orders Views (Sales & Purchases)
  // ──────────────────────────────────────────
  const loadPurchaseOrders = async () => {
    try {
      const orders = await api('/api/orders?type=PURCHASE');
      state.orders = orders || [];
      renderOrdersTable('purchaseOrdersTableBody', 'PURCHASE');
    } catch (err) {
      console.error(err);
    }
  };

  const loadSalesOrders = async () => {
    try {
      const orders = await api('/api/orders?type=SALE');
      state.orders = orders || [];
      renderOrdersTable('salesOrdersTableBody', 'SALE');
    } catch (err) {
      console.error(err);
    }
  };

  const renderOrdersTable = (tbodyId, type) => {
    const tbody = $(tbodyId);
    if (!tbody) return;

    let orders = (state.orders || []).filter((o) => o.type === type);
    if (state.searchQuery) {
      const q = state.searchQuery;
      orders = orders.filter((o) => o.order_number.toLowerCase().includes(q) || (o.contact_name || '').toLowerCase().includes(q));
    }

    if (orders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-slate-400">No ${type.toLowerCase()} orders found.</td></tr>`;
      return;
    }

    tbody.innerHTML = orders.map((o) => {
      let statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700" title="Draft — Not Sent Yet">DRAFT (Cart — Not Sent)</span>';
      if (o.status === 'CONFIRMED') statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200" title="Official Order — Stock Incoming or Reserved">CONFIRMED (Official)</span>';
      if (o.status === 'PARTIALLY_RECEIVED') statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">PARTIAL RECEIPT</span>';
      if (o.status === 'PARTIALLY_FULFILLED') statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">PARTIAL DISPATCH</span>';
      if (o.status === 'FULFILLED') statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">COMPLETED (Delivered)</span>';
      if (o.status === 'CANCELLED') statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">CANCELLED (Void)</span>';

      const canReceive = o.type === 'PURCHASE' && ['CONFIRMED', 'PARTIALLY_RECEIVED'].includes(o.status);
      const canFulfill = o.type === 'SALE' && ['CONFIRMED', 'PARTIALLY_FULFILLED'].includes(o.status);
      const isDraft = o.status === 'DRAFT';
      const isConfirmed = o.status === 'CONFIRMED';
      const hasPayments = (o.paid_cents || 0) > 0;
      const isPartial = ['PARTIALLY_RECEIVED', 'PARTIALLY_FULFILLED'].includes(o.status);

      return `
        <tr class="hover:bg-slate-50 transition-colors">
          <td class="py-3 px-4 font-bold text-slate-900 sticky left-0 bg-white shadow-2xs">${o.order_number}</td>
          <td class="py-3 px-4 font-semibold text-slate-800">${o.contact_name || '—'}</td>
          <td class="py-3 px-4 text-slate-500">${formatDate(o.created_at)}</td>
          <td class="py-3 px-4 text-slate-500">${formatDate(o.due_date)}</td>
          <td class="py-3 px-4 text-right font-bold text-slate-900">${formatMoney(o.total_cents)}</td>
          <td class="py-3 px-4 text-right font-semibold ${o.paid_cents >= o.total_cents ? 'text-emerald-600' : 'text-slate-600'}">
            ${formatMoney(o.paid_cents)}
          </td>
          <td class="py-3 px-4 text-center">${statusBadge}</td>
          <td class="py-3 px-4 text-right">
            <div class="inline-flex items-center gap-1.5 justify-end flex-wrap">
              ${isDraft ? `
                <button onclick="App.confirmOrderAction(${o.id}, '${o.type}')" class="px-2 py-1 rounded text-[11px] font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition">
                  Confirm
                </button>
                <button onclick="App.cancelOrderAction(${o.id}, '${o.type}')" class="px-2 py-1 rounded text-[11px] font-semibold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition">
                  Cancel
                </button>
              ` : ''}
              ${isConfirmed && !hasPayments ? `
                <button onclick="App.unconfirmOrderAction(${o.id}, '${o.type}')" title="Revert back to editable draft" class="px-2 py-1 rounded text-[11px] font-semibold bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 transition">
                  Revert to Draft
                </button>
                <button onclick="App.cancelOrderAction(${o.id}, '${o.type}')" title="Cancel this order" class="px-2 py-1 rounded text-[11px] font-semibold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition">
                  Cancel
                </button>
              ` : ''}
              ${(isPartial || (isConfirmed && hasPayments)) ? `
                <button onclick="App.voidAndRevertOrderAction(${o.id}, '${o.type}')" title="Reverse inventory movements and void allocations" class="px-2 py-1 rounded text-[11px] font-semibold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition">
                  Reverse / Void
                </button>
              ` : ''}
              ${canReceive ? `
                <button onclick="App.openReceivePoModal(${o.id})" class="px-2 py-1 rounded text-[11px] font-semibold bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition">
                  Receive
                </button>
              ` : ''}
              ${canFulfill ? `
                <button onclick="App.openFulfillSoModal(${o.id})" class="px-2 py-1 rounded text-[11px] font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition">
                  Dispatch
                </button>
              ` : ''}
              ${o.paid_cents < o.total_cents && o.status !== 'CANCELLED' ? `
                <button onclick="App.openPaymentForOrder(${o.id}, ${o.total_cents - o.paid_cents})" class="px-2 py-1 rounded text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition">
                  Pay
                </button>
              ` : (o.status !== 'CANCELLED' ? '<span class="text-slate-400 text-[10px] font-medium">Settled</span>' : '')}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  };

  // ──────────────────────────────────────────
  // Payments View
  // ──────────────────────────────────────────
  const loadPayments = async () => {
    try {
      const [fin, payments] = await Promise.all([
        api('/api/payments/summary', { silent: true }).catch(() => null),
        api('/api/payments?limit=50', { silent: true }).catch(() => [])
      ]);
      state.financialSummary = fin;

      const ar = fin?.accountsReceivable || {};
      const ap = fin?.accountsPayable || {};

      if ($('payArTotal')) $('payArTotal').textContent = formatMoney(ar.totalCents || 0);
      if ($('payArOverdue')) $('payArOverdue').textContent = `Overdue: ${formatMoney(ar.overdueCents || 0)}`;
      if ($('payArOpenCount')) $('payArOpenCount').textContent = `${ar.openInvoicesCount || 0} open invoices`;
      if ($('payArOverdueCount')) $('payArOverdueCount').textContent = `${ar.overdueInvoicesCount || 0} overdue invoices`;

      if ($('payApTotal')) $('payApTotal').textContent = formatMoney(ap.totalCents || 0);
      if ($('payApOverdue')) $('payApOverdue').textContent = `Overdue: ${formatMoney(ap.overdueCents || 0)}`;
      if ($('payApOpenCount')) $('payApOpenCount').textContent = `${ap.openBillsCount || 0} open bills`;
      if ($('payAp14d')) $('payAp14d').textContent = `Upcoming 14d: ${formatMoney(fin?.upcomingAp14dCents || 0)}`;

      const tbody = $('paymentAllocationsTableBody');
      if (tbody) {
        if (!payments || payments.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" class="py-12 text-center text-slate-400">No payment allocations recorded yet.</td></tr>';
          return;
        }

        tbody.innerHTML = payments.map((p) => `
          <tr class="hover:bg-slate-50 transition-colors ${p.is_voided ? 'opacity-60 bg-slate-50/50' : ''}">
            <td class="py-2.5 px-4 text-slate-500 font-mono text-[11px]">${formatDate(p.recorded_at)}</td>
            <td class="py-2.5 px-4 font-bold text-slate-800">${p.order_number}</td>
            <td class="py-2.5 px-4 text-slate-600">${p.contact_name || '—'}</td>
            <td class="py-2.5 px-4 text-center">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold ${p.order_type === 'SALE' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}">
                ${p.order_type}
              </span>
            </td>
            <td class="py-2.5 px-4 text-right font-bold text-slate-900">${formatMoney(p.amount_cents)}</td>
            <td class="py-2.5 px-4 text-slate-600">${p.payment_method}</td>
            <td class="py-2.5 px-4 text-slate-500 text-[11px]">
              ${p.is_voided ? `<span class="text-rose-600 font-bold">[VOIDED: ${p.void_reason || 'Reversed'}]</span> ` : ''}${p.notes || '—'}
            </td>
            <td class="py-2.5 px-4 text-right">
              ${p.is_voided ? `
                <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">VOIDED</span>
              ` : `
                <button onclick="App.voidPaymentAction(${p.id})" title="Void payment allocation" class="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition">
                  Void
                </button>
              `}
            </td>
          </tr>
        `).join('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // ──────────────────────────────────────────
  // ML Forecasts & Insights View
  // ──────────────────────────────────────────
  const loadInsightsOverview = async () => {
    try {
      // 1. Fetch Model Diagnostics
      try {
        const diag = await api('/api/intelligence/model-diagnostics');
        if (diag && diag.success) {
          if ($('diagAlgorithm')) $('diagAlgorithm').textContent = diag.modelName || 'LightGBM';
          if ($('diagTrainingVolume')) $('diagTrainingVolume').textContent = `${(diag.trainingRecords || 0).toLocaleString()} daily records`;
          if ($('diagSplit')) $('diagSplit').textContent = `${diag.testRecords || 0} test records (80/20 split)`;
          if ($('diagTestPerformance')) $('diagTestPerformance').textContent = `ML: ${diag.mlMae ?? 0} pcs vs Base: ${diag.baselineMae ?? 0} pcs`;
          if ($('diagImprovementBadge')) {
            const imp = typeof diag.improvementPct === 'number' ? diag.improvementPct : 0;
            if (imp > 0) {
              $('diagImprovementBadge').textContent = `${imp.toFixed(1)}% error reduction`;
              $('diagImprovementBadge').className = 'px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-100 text-emerald-800';
            } else {
              $('diagImprovementBadge').textContent = 'Baseline 7d SMA benchmark';
              $('diagImprovementBadge').className = 'px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-700';
            }
          }
          if ($('diagStatus')) $('diagStatus').textContent = diag.status || 'Trained & Synchronized to SQLite';
          if ($('diagLastUpdated') && diag.createdAt) {
            $('diagLastUpdated').textContent = new Date(diag.createdAt).toLocaleDateString();
          }
        }
      } catch (e) {
        console.warn('Diagnostics fetch warning:', e);
      }

      // 2. Fetch Catalog Positions and Forecasts
      const positions = await api('/api/inventory/positions');
      const tbody = $('forecastsTableBody');
      if (!tbody) return;

      if (!positions || positions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="py-12 text-center text-slate-400">No products available in catalog.</td></tr>';
        return;
      }

      // Fetch sample forecasts
      const rows = await Promise.all(positions.slice(0, 20).map(async (p) => {
        try {
          const fc = await api(`/api/intelligence/forecasts/${p.product_id}`);
          return {
            ...p,
            forecast: fc?.forecast
          };
        } catch {
          return { ...p, forecast: null };
        }
      }));

      tbody.innerHTML = rows.map((r) => {
        const f = r.forecast;
        const rawP50 = f ? (f.p50_qty ?? f.p50Qty ?? f.expected_demand ?? f.p50Total ?? 0) : null;
        const rawP90 = f ? (f.p90_qty ?? f.p90Qty ?? f.p90Total ?? 0) : null;
        const p50 = rawP50 !== null ? Math.round(rawP50) : '—';
        const p90 = rawP90 !== null ? Math.round(rawP90) : '—';
        const model = f ? (f.model_name || f.modelName || 'LightGBM / Regressor') : 'INSUFFICIENT_DATA';
        const uncert = f ? ((f.uncertaintyScore || f.uncertainty_score || 0.3) * 100).toFixed(0) + '%' : 'N/A';

        return `
          <tr class="hover:bg-slate-50 transition-colors">
            <td class="py-3 px-4">
              <span class="font-bold text-slate-900">${r.sku}</span>
              <div class="text-[11px] text-slate-500">${r.name}</div>
            </td>
            <td class="py-3 px-4">
              <span class="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-slate-100 text-slate-700">
                ${model}
              </span>
            </td>
            <td class="py-3 px-4 text-right font-bold text-slate-900">${p50} units</td>
            <td class="py-3 px-4 text-right font-bold text-amber-600">${p90} units</td>
            <td class="py-3 px-4 text-center font-semibold text-slate-700">${uncert}</td>
            <td class="py-3 px-4 text-right text-indigo-700 font-semibold">${r.min_safety_stock} ${r.base_unit}</td>
            <td class="py-3 px-4 text-right">
              <button onclick="App.openDrawerForProduct(${r.product_id})" class="px-2.5 py-1 rounded text-xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition">
                Inspect
              </button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.error(err);
    }
  };

  const openDrawerForProduct = (productId) => {
    openDrawer(productId);
  };

  // ──────────────────────────────────────────
  // Modals & Forms Handling
  // ──────────────────────────────────────────
  const openModal = (id) => {
    const modal = $(id);
    if (modal) modal.classList.remove('hidden');
  };

  const closeModal = (id) => {
    const modal = $(id);
    if (modal) modal.classList.add('hidden');
  };

  const closeBdClick = (event, id) => {
    if (event.target.id === id) closeModal(id);
  };

  const populateSelectOptions = () => {
    const adjustProdSelect = $('adjustProductSelect');
    if (adjustProdSelect) {
      adjustProdSelect.innerHTML = '<option value="">Select product…</option>' +
        state.products.map((p) => `<option value="${p.product_id}" data-stock="${p.on_hand}">${p.sku} — ${p.name} (${p.on_hand} in stock)</option>`).join('');
    }

    const adjustLocSelect = $('adjustLocationSelect');
    if (adjustLocSelect) {
      adjustLocSelect.innerHTML = state.locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
    }
  };

  // Order Modal
  let orderLines = [];

  const openOrderModal = (type = 'SALE') => {
    const title = $('orderModalTitle');
    const typeInput = $('orderFormType');
    const contactLabel = $('orderContactLabel');
    const contactSelect = $('orderContactSelect');

    if (typeInput) typeInput.value = type;
    if (title) title.textContent = type === 'SALE' ? 'Create Sales Order (Customer Demand)' : 'Create Purchase Order (Inbound Restock)';
    if (contactLabel) contactLabel.textContent = type === 'SALE' ? 'Customer *' : 'Supplier *';

    if (contactSelect) {
      const filtered = state.contacts.filter((c) => c.type === (type === 'SALE' ? 'CUSTOMER' : 'SUPPLIER'));
      contactSelect.innerHTML = '<option value="">Select party…</option>' +
        filtered.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
    }

    orderLines = [];
    addOrderLine();
    updateOrderTotal();

    const dueEl = $('orderDueDate');
    if (dueEl) {
      const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      dueEl.value = d.toISOString().split('T')[0];
    }

    openModal('orderModal');
  };

  const addOrderLine = () => {
    const lineId = Date.now() + Math.random();
    orderLines.push({ id: lineId, product_id: '', quantity: 1, unit_price: 0 });
    renderOrderLines();
  };

  const removeOrderLine = (id) => {
    orderLines = orderLines.filter((l) => l.id !== id);
    if (orderLines.length === 0) addOrderLine();
    renderOrderLines();
  };

  const renderOrderLines = () => {
    const container = $('orderLinesContainer');
    if (!container) return;

    container.innerHTML = orderLines.map((line) => `
      <div class="flex items-center gap-2 text-xs" data-line-id="${line.id}">
        <select onchange="App.handleLineProductChange(${line.id}, this.value)" class="flex-1 border border-slate-300 rounded-md p-1.5 bg-white text-xs" required>
          <option value="">Select item…</option>
          ${state.products.map((p) => `<option value="${p.product_id}" ${p.product_id == line.product_id ? 'selected' : ''}>${p.sku} — ${p.name}</option>`).join('')}
        </select>
        <input type="number" min="1" value="${line.quantity}" onchange="App.handleLineQtyChange(${line.id}, this.value)" placeholder="Qty" class="w-16 border border-slate-300 rounded-md p-1.5 text-xs text-right" required />
        <input type="number" step="0.01" min="0" value="${line.unit_price}" onchange="App.handleLinePriceChange(${line.id}, this.value)" placeholder="Price" class="w-20 border border-slate-300 rounded-md p-1.5 text-xs text-right" required />
        <button type="button" onclick="App.removeOrderLine(${line.id})" class="text-rose-600 hover:text-rose-800 p-1">&times;</button>
      </div>
    `).join('');

    updateOrderTotal();
  };

  const handleLineProductChange = (lineId, prodId) => {
    const line = orderLines.find((l) => l.id === lineId);
    if (!line) return;
    line.product_id = prodId;

    const prod = state.products.find((p) => p.product_id == prodId);
    if (prod) {
      const type = $('orderFormType').value;
      const priceCents = type === 'SALE' ? prod.sell_price_cents : prod.cost_price_cents;
      line.unit_price = (priceCents / 100).toFixed(2);
    }
    renderOrderLines();
  };

  const handleLineQtyChange = (lineId, qty) => {
    const line = orderLines.find((l) => l.id === lineId);
    if (line) line.quantity = Math.max(1, parseInt(qty, 10) || 1);
    updateOrderTotal();
  };

  const handleLinePriceChange = (lineId, price) => {
    const line = orderLines.find((l) => l.id === lineId);
    if (line) line.unit_price = parseFloat(price) || 0;
    updateOrderTotal();
  };

  const updateOrderTotal = () => {
    let total = 0;
    orderLines.forEach((l) => {
      total += (l.quantity || 0) * (parseFloat(l.unit_price) || 0);
    });
    if ($('orderRunningTotal')) {
      $('orderRunningTotal').textContent = '$' + total.toFixed(2);
    }
  };

  const submitOrder = async (e) => {
    e.preventDefault();
    const form = e.target;
    const type = form.type.value;
    const contactId = form.contact_id.value;
    const dueDate = form.due_date.value;
    const notes = form.notes.value;
    const allowBackorder = form.allow_backorder?.checked || false;

    if (!contactId) {
      showToast(type === 'SALE' ? 'Please select a customer.' : 'Please select a supplier.', 'error');
      return;
    }

    const lines = orderLines
      .filter((l) => l.product_id && l.quantity > 0)
      .map((l) => {
        const prod = state.products.find((p) => p.product_id == l.product_id);
        const packSize = prod ? prod.pack_size : 1;
        return {
          product_id: parseInt(l.product_id, 10),
          quantity: parseInt(l.quantity, 10),
          pack_quantity: Math.ceil(l.quantity / packSize),
          unit_price_cents: Math.round(parseFloat(l.unit_price) * 100)
        };
      });

    if (lines.length === 0) {
      showToast('Please add at least one line item with a quantity.', 'error');
      return;
    }

    try {
      const prefix = type === 'SALE' ? 'SO' : 'PO';
      const orderNumber = `${prefix}-${Date.now().toString().slice(-6)}`;
      await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          contact_id: parseInt(contactId, 10),
          contactId: parseInt(contactId, 10),
          order_number: orderNumber,
          orderNumber,
          type,
          due_date: dueDate,
          dueDate,
          notes,
          allow_backorder: allowBackorder,
          allowBackorder,
          lines
        })
      });

      showToast(`${type === 'SALE' ? 'Sales Order' : 'Purchase Order'} #${orderNumber} created successfully!`, 'success');
      closeModal('orderModal');
      loadInitialData();
      if (type === 'SALE') loadSalesOrders();
      else loadPurchaseOrders();
    } catch (err) {
      console.error(err);
    }
  };

  // Stock Adjust Modal
  let adjustMode = 'delta';

  const openAdjustModal = () => {
    populateSelectOptions();
    toggleAdjustMode('delta');
    openModal('adjustModal');
  };

  const openAdjustForProduct = (productId) => {
    openAdjustModal();
    const select = $('adjustProductSelect');
    if (select) {
      select.value = productId;
      handleAdjustProductChange();
    }
  };

  const toggleAdjustMode = (mode) => {
    adjustMode = mode;
    const deltaGroup = $('adjustDeltaGroup');
    const targetGroup = $('adjustTargetGroup');
    if (mode === 'delta') {
      if (deltaGroup) deltaGroup.classList.remove('hidden');
      if (targetGroup) targetGroup.classList.add('hidden');
    } else {
      if (deltaGroup) deltaGroup.classList.add('hidden');
      if (targetGroup) targetGroup.classList.remove('hidden');
    }
  };

  const handleAdjustProductChange = () => {
    const select = $('adjustProductSelect');
    const label = $('adjustCurrentStockLabel');
    const opt = select.selectedOptions[0];
    if (opt && opt.value) {
      const p = state.products.find((i) => i.product_id == opt.value);
      if (p && label) {
        label.textContent = `Current physical balance: ${p.on_hand} ${p.base_unit} (Available: ${p.available})`;
        if ($('adjustNewOnHand')) $('adjustNewOnHand').value = p.on_hand;
      }
    } else if (label) {
      label.textContent = '';
    }
  };

  const submitStockAdjust = async (e) => {
    e.preventDefault();
    const form = e.target;
    const productId = form.product_id.value;
    const locationId = form.location_id.value;
    const reason = form.reason.value;
    const allowBackorder = form.allow_backorder?.checked || false;

    const payload = {
      product_id: parseInt(productId, 10),
      location_id: locationId ? parseInt(locationId, 10) : null,
      reason,
      allow_backorder: allowBackorder
    };

    if (adjustMode === 'delta') {
      const deltaVal = $('adjustChangeQty')?.value;
      if (deltaVal === '' || isNaN(parseInt(deltaVal, 10))) {
        showToast('Please enter a quantity change (+ or -).', 'error');
        return;
      }
      payload.change_qty = parseInt(deltaVal, 10);
    } else {
      const targetVal = $('adjustNewOnHand')?.value;
      if (targetVal === '' || isNaN(parseInt(targetVal, 10))) {
        showToast('Please enter a target on-hand count.', 'error');
        return;
      }
      payload.new_on_hand = parseInt(targetVal, 10);
    }

    try {
      const res = await api('/api/inventory/adjust', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      showToast(res?.message || 'Stock adjustment recorded successfully!', 'success');
      closeModal('adjustModal');
      form.reset();
      loadInventory();
      loadOverviewData();
    } catch (err) {
      console.warn('Adjust stock catch:', err);
    }
  };

  // Payment Modal
  const openPaymentModal = async () => {
    try {
      const orders = await api('/api/orders?limit=100');
      const unpaid = (orders || []).filter((o) => o.paid_cents < o.total_cents && o.status !== 'CANCELLED');
      const select = $('paymentOrderSelect');
      if (select) {
        select.innerHTML = '<option value="">Select order with unpaid balance…</option>' +
          unpaid.map((o) => `
            <option value="${o.id}" data-total="${o.total_cents}" data-paid="${o.paid_cents}">
              ${o.order_number} (${o.type}) — Unpaid: ${formatMoney(o.total_cents - o.paid_cents)}
            </option>
          `).join('');
      }
      openModal('paymentModal');
    } catch (err) {
      console.error(err);
    }
  };

  const openPaymentForOrder = async (orderId, remainingCents) => {
    await openPaymentModal();
    const select = $('paymentOrderSelect');
    if (select) {
      select.value = orderId;
      handlePaymentOrderChange();
      const amountInput = $('paymentAmountDollars');
      if (amountInput) amountInput.value = (remainingCents / 100).toFixed(2);
    }
  };

  const handlePaymentOrderChange = () => {
    const select = $('paymentOrderSelect');
    const notice = $('paymentOrderBalanceNotice');
    const opt = select.selectedOptions[0];
    if (opt && opt.dataset.total) {
      const remaining = parseInt(opt.dataset.total, 10) - parseInt(opt.dataset.paid, 10);
      notice.textContent = `Remaining Balance: ${formatMoney(remaining)}`;
      const amountInput = $('paymentAmountDollars');
      if (amountInput && (!amountInput.value || parseFloat(amountInput.value) <= 0)) {
        amountInput.value = (remaining / 100).toFixed(2);
      }
    } else {
      notice.textContent = '';
    }
  };

  const submitPayment = async (e) => {
    e.preventDefault();
    const form = e.target;
    const orderId = form.order_id.value;
    const amountDollars = parseFloat(form.amount_dollars.value);
    const paymentMethod = form.payment_method.value;
    const notes = form.notes.value;

    try {
      await api('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          order_id: parseInt(orderId, 10),
          amount_cents: Math.round(amountDollars * 100),
          payment_method: paymentMethod,
          notes
        })
      });

      showToast('Payment allocation recorded successfully!', 'success');
      closeModal('paymentModal');
      form.reset();
      loadOverviewData();
      if (state.currentTab === 'payments') loadPayments();
      if (state.currentTab === 'sales') loadSalesOrders();
      if (state.currentTab === 'purchases') loadPurchaseOrders();
    } catch (err) {
      console.error(err);
    }
  };

  // ──────────────────────────────────────────
  // CSV & PDF Catalog Import Management
  // ──────────────────────────────────────────
  let activeImportTab = 'file';
  let importParsedProducts = [];
  let currentImportFile = null;

  const openImportModal = () => {
    toggleImportTab('file');
    clearImportFile();
    openModal('importModal');
  };

  const toggleImportTab = (tab) => {
    activeImportTab = tab;
    const tabFile = $('importTabFile');
    const tabPaste = $('importTabPaste');
    const paneFile = $('importPaneFile');
    const panePaste = $('importPanePaste');

    if (tab === 'file') {
      if (tabFile) tabFile.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white shadow-2xs';
      if (tabPaste) tabPaste.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100';
      if (paneFile) paneFile.classList.remove('hidden');
      if (panePaste) panePaste.classList.add('hidden');
    } else {
      if (tabPaste) tabPaste.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white shadow-2xs';
      if (tabFile) tabFile.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100';
      if (panePaste) panePaste.classList.remove('hidden');
      if (paneFile) paneFile.classList.add('hidden');
    }
  };

  const clearImportFile = () => {
    currentImportFile = null;
    importParsedProducts = [];
    if ($('importFileInput')) $('importFileInput').value = '';
    if ($('importFileInfo')) $('importFileInfo').classList.add('hidden');
    if ($('importPreviewContainer')) $('importPreviewContainer').classList.add('hidden');
    if ($('importPreviewTbody')) $('importPreviewTbody').innerHTML = '';
  };

  const handleImportDrop = (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      processImportFile(files[0]);
    }
  };

  const handleImportFileSelect = (e) => {
    const files = e.target?.files;
    if (files && files.length > 0) {
      processImportFile(files[0]);
    }
  };

  const parseExtractedLines = (lines) => {
    const products = [];
    const seenSkus = new Set();

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i].trim();
      if (!rawLine || rawLine.length < 3) continue;
      if (/^(sku|product|item|description|page|total|invoice|catalog|code|name|unit\s*price|subtotal|sl\s*no)/i.test(rawLine)) continue;

      if (rawLine.includes(',') || rawLine.includes('\t') || rawLine.includes('|') || rawLine.includes(';')) {
        const delim = rawLine.includes('\t') ? '\t' : (rawLine.includes('|') ? '|' : (rawLine.includes(';') ? ';' : ','));
        const parts = rawLine.split(delim).map(s => s.trim().replace(/^["']|["']$/g, ''));
        if (parts.length >= 2 && parts[0].length >= 2) {
          const sku = parts[0].replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
          if (sku.length >= 2 && !seenSkus.has(sku)) {
            seenSkus.add(sku);
            const cost = parseFloat(parts[3]) || 0;
            const sell = parseFloat(parts[4]) || (cost > 0 ? +(cost * 1.5).toFixed(2) : 0);
            products.push({
              sku,
              barcode: parts[1] && parts[1].length > 4 && /^\d+$/.test(parts[1]) ? parts[1] : sku,
              name: parts[1] && !/^\d+$/.test(parts[1]) ? parts[1] : (parts[2] || sku),
              category: parts[2] && isNaN(parseFloat(parts[2])) ? parts[2] : 'Catalog_Import',
              pack_size: parseInt(parts[5], 10) || 1,
              cost_price: cost || 10.0,
              sell_price: sell || 19.99,
              initial_stock: parseInt(parts[6] || parts[5] || 0, 10) || 0,
              lead_days: 7,
              min_safety_stock: 5
            });
            continue;
          }
        }
      }

      const tokens = rawLine.split(/\s+/).filter(Boolean);
      if (tokens.length >= 3) {
        const skuCandidate = tokens[0].replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
        if (skuCandidate.length >= 3 && /^[A-Z0-9]/.test(skuCandidate) && !seenSkus.has(skuCandidate)) {
          const prices = [];
          const words = [];
          let stock = 0;
          for (let j = 1; j < tokens.length; j++) {
            const tok = tokens[j].replace(/[$,]/g, '');
            const num = parseFloat(tok);
            if (!isNaN(num) && /^\d+(\.\d{1,2})?$/.test(tok)) {
              prices.push(num);
            } else {
              words.push(tokens[j]);
            }
          }
          if (words.length > 0 || prices.length > 0) {
            seenSkus.add(skuCandidate);
            const cost = prices[0] || 10.0;
            const sell = prices[1] || (prices[0] ? +(prices[0] * 1.6).toFixed(2) : 25.0);
            if (prices.length > 2 && Number.isInteger(prices[2])) {
              stock = parseInt(prices[2], 10);
            }
            products.push({
              sku: skuCandidate,
              barcode: skuCandidate,
              name: words.join(' ') || `Product ${skuCandidate}`,
              category: 'Catalog_Import',
              pack_size: 1,
              cost_price: cost,
              sell_price: sell,
              initial_stock: stock,
              lead_days: 7,
              min_safety_stock: 5
            });
          }
        }
      }
    }
    return products;
  };

  const processImportFile = async (file) => {
    if (!file) return;
    currentImportFile = file;

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

    if ($('importFileName')) $('importFileName').textContent = file.name;
    if ($('importFileSize')) $('importFileSize').textContent = `${(file.size / 1024).toFixed(1)} KB • Parsing…`;
    if ($('importFileTypeBadge')) $('importFileTypeBadge').textContent = isPdf ? 'PDF' : 'CSV';
    if ($('importFileInfo')) $('importFileInfo').classList.remove('hidden');

    let parsedProducts = [];

    if (isPdf) {
      try {
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          const arrayBuffer = await file.arrayBuffer();
          const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
          const extractedLines = [];
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const linesMap = new Map();
            for (const item of textContent.items) {
              if (!item.str || !item.str.trim()) continue;
              const y = Math.round(item.transform[5]);
              if (!linesMap.has(y)) linesMap.set(y, []);
              linesMap.get(y).push({ x: item.transform[4], str: item.str });
            }
            const sortedYs = Array.from(linesMap.keys()).sort((a, b) => b - a);
            for (const y of sortedYs) {
              const rowItems = linesMap.get(y).sort((a, b) => a.x - b.x);
              const lineStr = rowItems.map(it => it.str).join('   ').trim();
              if (lineStr) extractedLines.push(lineStr);
            }
          }
          parsedProducts = parseExtractedLines(extractedLines);
        }
      } catch (clientPdfErr) {
        console.warn('Client PDF.js parsing failed, falling back to server document parser:', clientPdfErr);
      }

      if (parsedProducts.length === 0) {
        try {
          const reader = new FileReader();
          const base64Promise = new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const b64 = await base64Promise;
          const serverRes = await api('/api/data/parse-document', {
            method: 'POST',
            body: JSON.stringify({
              document_base64: b64,
              file_type: 'application/pdf',
              file_name: file.name
            })
          });
          if (serverRes && Array.isArray(serverRes.products)) {
            parsedProducts = serverRes.products;
          }
        } catch (serverPdfErr) {
          console.warn('Server PDF parser error:', serverPdfErr);
        }
      }
    } else {
      try {
        const text = await file.text();
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        parsedProducts = parseExtractedLines(lines);
      } catch (csvErr) {
        console.error('CSV parse error:', csvErr);
      }
    }

    importParsedProducts = parsedProducts;
    if ($('importFileSize')) {
      $('importFileSize').textContent = `${(file.size / 1024).toFixed(1)} KB • Extracted ${parsedProducts.length} items`;
    }

    if (parsedProducts.length > 0) {
      if ($('importPreviewBadge')) $('importPreviewBadge').textContent = `${parsedProducts.length} items ready to import`;
      if ($('importPreviewTbody')) {
        $('importPreviewTbody').innerHTML = parsedProducts.map(p => `
          <tr class="hover:bg-slate-50 transition-colors">
            <td class="p-2 font-mono font-bold text-indigo-700">${p.sku}</td>
            <td class="p-2 font-medium text-slate-900">${p.name}</td>
            <td class="p-2 text-slate-500">${p.category}</td>
            <td class="p-2 text-right font-mono text-slate-700">${p.pack_size || 1}</td>
            <td class="p-2 text-right font-mono text-slate-700">$${(parseFloat(p.cost_price) || 0).toFixed(2)}</td>
            <td class="p-2 text-right font-mono font-bold text-emerald-700">$${(parseFloat(p.sell_price) || 0).toFixed(2)}</td>
            <td class="p-2 text-right font-mono text-slate-600">${p.initial_stock || 0}</td>
          </tr>
        `).join('');
      }
      if ($('importPreviewContainer')) $('importPreviewContainer').classList.remove('hidden');
    } else {
      if ($('importPreviewBadge')) $('importPreviewBadge').textContent = 'No products recognized';
      if ($('importPreviewTbody')) {
        $('importPreviewTbody').innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">No tabular products could be recognized in ${file.name}. Please ensure the file has SKU and item descriptions.</td></tr>`;
      }
      if ($('importPreviewContainer')) $('importPreviewContainer').classList.remove('hidden');
    }
  };

  const submitImport = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const sourceTag = $('importSourceTag')?.value || 'VENDOR_FEED';

    if (activeImportTab === 'file') {
      if (importParsedProducts.length === 0) {
        showToast('Please upload a valid PDF or CSV file with recognized products first.', 'error');
        return;
      }

      try {
        const res = await api('/api/data/import', {
          method: 'POST',
          body: JSON.stringify({
            rows: importParsedProducts,
            source_tag: sourceTag
          })
        });

        const count = res.importedCount || res.imported_count || importParsedProducts.length;
        showToast(`Successfully imported ${count} products from ${currentImportFile?.name || 'document'}!`, 'success');
        closeModal('importModal');
        clearImportFile();
        loadInitialData();
        loadInventory();
        loadCatalogData();
      } catch (err) {
        console.error('File import error:', err);
      }
    } else {
      const csvText = $('importCsvText')?.value?.trim();
      if (!csvText) {
        showToast('Please paste CSV rows to import.', 'error');
        return;
      }

      try {
        const res = await api('/api/data/import', {
          method: 'POST',
          body: JSON.stringify({
            csv_text: csvText,
            source_tag: sourceTag
          })
        });

        const count = res.importedCount || res.imported_count || 'catalog';
        showToast(`Successfully imported ${count} products!`, 'success');
        closeModal('importModal');
        if ($('importCsvText')) $('importCsvText').value = '';
        loadInitialData();
        loadInventory();
        loadCatalogData();
      } catch (err) {
        console.error('CSV import error:', err);
      }
    }
  };

  // Add Product Modal
  const openNewProductModal = () => openModal('newProductModal');

  const submitNewProduct = async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      sku: form.sku.value.trim(),
      barcode: form.barcode.value.trim(),
      name: form.name.value.trim(),
      category: form.category.value.trim() || 'General',
      base_unit: form.base_unit.value.trim() || 'pcs',
      pack_size: parseInt(form.pack_size.value, 10) || 1,
      lead_days: parseInt(form.lead_days.value, 10) || 7,
      cost_price_cents: Math.round(parseFloat(form.cost_price.value || 0) * 100),
      sell_price_cents: Math.round(parseFloat(form.sell_price.value || 0) * 100),
      min_safety_stock: parseInt(form.min_safety_stock.value, 10) || 10,
      initial_stock: parseInt(form.initial_stock.value, 10) || 0
    };

    try {
      await api('/api/inventory/products', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      showToast(`Product ${payload.sku} added to catalog!`, 'success');
      closeModal('newProductModal');
      form.reset();
      loadInitialData();
    } catch (err) {
      console.error(err);
    }
  };

  // ──────────────────────────────────────────
  // Order Lifecycle (Confirmation, Receiving, Dispatch)
  // ──────────────────────────────────────────
  const confirmOrderAction = async (orderId, type) => {
    try {
      await api(`/api/orders/${orderId}/confirm`, { method: 'POST' });
      showToast(`${type} Order confirmed successfully!`, 'success');
      if (type === 'PURCHASE') loadPurchaseOrders();
      else loadSalesOrders();
      loadOverviewData();
      loadInventory();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const openReceivePoModal = async (orderId) => {
    try {
      const order = await api(`/api/orders/${orderId}`);
      if (!order) return;

      $('receivePoId').value = order.id;
      $('receivePoTitle').textContent = `Receive PO #${order.order_number}`;

      const container = $('receivePoLinesContainer');
      if (container) {
        container.innerHTML = order.lines.map((l) => {
          const remaining = l.quantity - (l.received_quantity || 0);
          return `
            <div class="p-3 rounded-lg border border-slate-200 bg-slate-50 flex flex-col gap-2">
              <div class="flex items-center justify-between text-xs">
                <div>
                  <span class="font-bold text-slate-800">${l.sku}</span>
                  <span class="text-slate-500 ml-1">(${l.name})</span>
                </div>
                <div class="text-slate-600">
                  Total: <span class="font-semibold">${l.quantity}</span> | Remaining: <span class="font-bold text-indigo-700">${remaining}</span>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Quantity Receiving Now</label>
                  <input type="number" min="0" max="${remaining}" value="${remaining}" data-line-id="${l.id}" class="receive-line-qty w-full text-xs border border-slate-300 rounded px-2.5 py-1.5 bg-white" />
                </div>
                <div>
                  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Condition / Stock Type</label>
                  <select data-line-id="${l.id}" class="receive-line-type w-full text-xs border border-slate-300 rounded px-2 py-1.5 bg-white">
                    <option value="AVAILABLE">Available (In Good Condition)</option>
                    <option value="DAMAGED">Damaged (Defective / Quarantine)</option>
                  </select>
                </div>
              </div>
            </div>
          `;
        }).join('');
      }

      openModal('receivePoModal');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const submitReceivePo = async (e) => {
    e.preventDefault();
    const orderId = $('receivePoId').value;
    const qtyInputs = document.querySelectorAll('.receive-line-qty');
    const typeInputs = document.querySelectorAll('.receive-line-type');

    const items = [];
    qtyInputs.forEach((inp) => {
      const lineId = parseInt(inp.dataset.lineId, 10);
      const qty = parseInt(inp.value, 10);
      const stockType = Array.from(typeInputs).find((t) => t.dataset.lineId == lineId)?.value || 'AVAILABLE';
      if (qty > 0) {
        items.push({ line_id: lineId, quantity: qty, stock_type: stockType });
      }
    });

    if (items.length === 0) {
      showToast('Please enter a quantity greater than zero for at least one item.', 'error');
      return;
    }

    try {
      await api(`/api/orders/${orderId}/receive`, {
        method: 'POST',
        body: JSON.stringify({ items })
      });

      showToast('Inbound items received and stock updated!', 'success');
      closeModal('receivePoModal');
      loadPurchaseOrders();
      loadInventory();
      loadOverviewData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const openFulfillSoModal = async (orderId) => {
    try {
      const order = await api(`/api/orders/${orderId}`);
      if (!order) return;

      $('fulfillSoId').value = order.id;
      $('fulfillSoTitle').textContent = `Dispatch Sales Order #${order.order_number}`;

      const container = $('fulfillSoLinesContainer');
      if (container) {
        container.innerHTML = order.lines.map((l) => {
          const remaining = l.quantity - (l.fulfilled_quantity || 0);
          return `
            <div class="p-3 rounded-lg border border-slate-200 bg-slate-50 flex flex-col gap-2">
              <div class="flex items-center justify-between text-xs">
                <div>
                  <span class="font-bold text-slate-800">${l.sku}</span>
                  <span class="text-slate-500 ml-1">(${l.name})</span>
                </div>
                <div class="text-slate-600">
                  Total: <span class="font-semibold">${l.quantity}</span> | Remaining: <span class="font-bold text-indigo-700">${remaining}</span>
                </div>
              </div>
              <div>
                <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Dispatch Quantity Now</label>
                <input type="number" min="0" max="${remaining}" value="${remaining}" data-line-id="${l.id}" class="fulfill-line-qty w-full text-xs border border-slate-300 rounded px-2.5 py-1.5 bg-white" />
              </div>
            </div>
          `;
        }).join('');
      }

      openModal('fulfillSoModal');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const submitFulfillSo = async (e) => {
    e.preventDefault();
    const orderId = $('fulfillSoId').value;
    const qtyInputs = document.querySelectorAll('.fulfill-line-qty');

    const items = [];
    qtyInputs.forEach((inp) => {
      const lineId = parseInt(inp.dataset.lineId, 10);
      const qty = parseInt(inp.value, 10);
      if (qty > 0) {
        items.push({ line_id: lineId, quantity: qty });
      }
    });

    if (items.length === 0) {
      showToast('Please enter a quantity greater than zero for at least one item.', 'error');
      return;
    }

    try {
      await api(`/api/orders/${orderId}/fulfill-partial`, {
        method: 'POST',
        body: JSON.stringify({ items })
      });

      showToast('Sales order dispatched and reservations updated!', 'success');
      closeModal('fulfillSoModal');
      loadSalesOrders();
      loadInventory();
      loadOverviewData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ──────────────────────────────────────────
  // Product Archival (Immutable Audit Preservation)
  // ──────────────────────────────────────────
  const archiveProductAction = async (productId, sku) => {
    if (!confirm(`Are you sure you want to archive SKU "${sku}"? Historical transaction records and audit ledger will be preserved.`)) return;
    try {
      await api(`/api/inventory/products/${productId}/archive`, { method: 'POST' });
      showToast(`SKU ${sku} archived successfully!`, 'success');
      loadInventory();
      loadOverviewData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const unarchiveProductAction = async (productId, sku) => {
    try {
      await api(`/api/inventory/products/${productId}/unarchive`, { method: 'POST' });
      showToast(`SKU ${sku} unarchived and active!`, 'success');
      loadInventory();
      loadOverviewData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ──────────────────────────────────────────
  // Physical Cycle Count Audit
  // ──────────────────────────────────────────
  let activeCycleCountView = 'list';

  const openCycleCountModal = async () => {
    toggleCycleCountView('list');
    await loadCycleCountsList();
    openModal('cycleCountModal');
  };

  const toggleCycleCountView = (view) => {
    activeCycleCountView = view;
    const btnList = $('ccTabList');
    const btnNew = $('ccTabNew');
    if (btnList && btnNew) {
      if (view === 'list') {
        btnList.className = 'px-3 py-1 rounded-md text-xs font-semibold bg-indigo-600 text-white';
        btnNew.className = 'px-3 py-1 rounded-md text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100';
        loadCycleCountsList();
      } else {
        btnNew.className = 'px-3 py-1 rounded-md text-xs font-semibold bg-indigo-600 text-white';
        btnList.className = 'px-3 py-1 rounded-md text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100';
        renderNewCycleCountForm();
      }
    }
  };

  const loadCycleCountsList = async () => {
    const body = $('cycleCountBody');
    if (!body) return;
    try {
      const counts = await api('/api/inventory/cycle-counts');
      if (!counts || counts.length === 0) {
        body.innerHTML = `
          <div class="py-12 text-center text-slate-400">
            <p class="font-semibold text-slate-600 mb-1">No Cycle Count Audits</p>
            <p class="text-xs">Start a periodic physical recount to maintain 99%+ inventory accuracy.</p>
            <button onclick="App.toggleCycleCountView('new')" class="mt-4 px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold shadow-xs">
              + Start First Audit
            </button>
          </div>
        `;
        return;
      }

      body.innerHTML = `
        <div class="space-y-3">
          ${counts.map((c) => {
            let statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">IN PROGRESS</span>';
            if (c.status === 'APPROVED') statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">APPROVED & RECONCILED</span>';
            if (c.status === 'CANCELLED') statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500">CANCELLED</span>';

            return `
              <div class="p-4 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between hover:bg-slate-100/80 transition">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="font-bold text-slate-900">${c.count_number}</span>
                    ${statusBadge}
                  </div>
                  <p class="text-xs text-slate-500 mt-1">Location: <strong class="text-slate-700">${c.location_name || 'Central Warehouse'}</strong> • Created: ${formatDate(c.created_at)}</p>
                  <p class="text-[11px] text-slate-400 mt-0.5">${c.item_count || 0} items audited ${c.blind_count ? '(Blind audit)' : ''}</p>
                </div>
                <div>
                  <button onclick="App.openCycleCountDetail(${c.id})" class="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 shadow-2xs">
                    Inspect & Count →
                  </button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="text-rose-600 text-xs text-center py-6">${err.message}</p>`;
    }
  };

  const renderNewCycleCountForm = () => {
    const body = $('cycleCountBody');
    if (!body) return;

    body.innerHTML = `
      <form id="newCycleCountForm" onsubmit="App.submitNewCycleCount(event)" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">Audit Reference Number *</label>
          <input name="count_number" value="CC-${Date.now().toString().slice(-6)}" required class="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 bg-white" />
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">Target Warehouse Location *</label>
          <select name="location_id" id="ccLocSelect" required class="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 bg-white">
            ${(state.locations || []).map((l) => `<option value="${l.id}">${l.name}</option>`).join('')}
          </select>
        </div>
        <div class="flex items-center pt-1">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" name="blind_count" value="1" checked class="rounded text-indigo-600" />
            <div>
              <span class="text-xs font-semibold text-slate-800">Blind Count Mode (Recommended)</span>
              <p class="text-[10px] text-slate-500">Hides system expected quantity from counting staff to eliminate bias.</p>
            </div>
          </label>
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">Audit Scope / Notes</label>
          <input name="notes" placeholder="e.g. End of month electronics cycle count" class="w-full text-xs border border-slate-300 rounded-lg px-3 py-2" />
        </div>
        <div class="flex justify-end pt-3 border-t border-slate-100">
          <button type="submit" class="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs transition shadow-xs">
            Initialize Cycle Count Audit
          </button>
        </div>
      </form>
    `;
  };

  const submitNewCycleCount = async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      const locVal = form.location_id?.value;
      const payload = {
        count_number: form.count_number.value.trim(),
        countNumber: form.count_number.value.trim(),
        location_id: locVal ? parseInt(locVal, 10) : 1,
        locationId: locVal ? parseInt(locVal, 10) : 1,
        is_blind_count: form.blind_count?.checked ? true : false,
        blindCount: form.blind_count?.checked ? 1 : 0,
        notes: form.notes?.value?.trim() || ''
      };

      const res = await api('/api/inventory/cycle-counts', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      showToast(`Cycle Count ${res.count_number || 'Audit'} initialized!`, 'success');
      openCycleCountDetail(res.cycleCountId || res.id);
    } catch (err) {
      console.warn('Cycle count init catch:', err);
    }
  };

  const openCycleCountDetail = async (cycleCountId) => {
    const body = $('cycleCountBody');
    if (!body) return;

    try {
      const data = await api(`/api/inventory/cycle-counts/${cycleCountId}`);
      if (!data) return;

      const cc = data.cycleCount || data;
      const items = data.items || [];
      const isApproved = cc.status === 'APPROVED';

      let totalVarianceCents = 0;
      items.forEach((it) => {
        const count = it.final_counted_qty !== null ? it.final_counted_qty : it.counted_qty;
        if (count !== null && it.system_on_hand !== undefined) {
          totalVarianceCents += Math.abs((count - it.system_on_hand) * (it.cost_price_cents || 0));
        }
      });

      const threshold = cc.approval_threshold_cents || 50000;
      const requiresOwner = totalVarianceCents > threshold;

      body.innerHTML = `
        <div class="space-y-4">
          <div class="flex items-center justify-between pb-3 border-b border-slate-200">
            <div>
              <h4 class="font-bold text-slate-900">${cc.count_number}</h4>
              <p class="text-[11px] text-slate-500">Status: <strong class="text-slate-800">${cc.status}</strong> • Threshold: ${formatMoney(threshold)}</p>
            </div>
            ${!isApproved ? `
              <button onclick="App.approveCycleCount(${cc.id})" class="px-4 py-2 rounded-lg ${requiresOwner ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700'} text-white font-semibold text-xs shadow-xs">
                ${requiresOwner ? 'Approve Reconciliation (Requires OWNER)' : 'Approve & Reconcile Stock'}
              </button>
            ` : `
              <span class="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
                ✓ Reconciled & Closed
              </span>
            `}
          </div>

          <div class="space-y-2.5 max-h-96 overflow-y-auto">
            ${items.map((it) => {
              const currentCount = it.final_counted_qty !== null ? it.final_counted_qty : (it.counted_qty !== null ? it.counted_qty : '');
              return `
                <div class="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <p class="font-bold text-slate-900 text-xs">${it.sku} - ${it.name}</p>
                    <p class="text-[11px] text-slate-500">
                      System Balance: ${cc.blind_count && !isApproved && currentCount === '' ? '<span class="italic text-slate-400">Masked (Blind)</span>' : `<strong>${it.system_on_hand}</strong> units`}
                    </p>
                  </div>
                  <div class="flex items-center gap-2" onclick="event.stopPropagation()">
                    ${!isApproved ? `
                      <input type="number" min="0" placeholder="Count" value="${currentCount}"
                        onchange="App.recordCountItem(${cc.id}, ${it.product_id}, this.value)"
                        class="w-20 text-xs border border-slate-300 rounded px-2.5 py-1.5 bg-white text-right font-bold" />
                      <select onchange="App.recordCountReason(${cc.id}, ${it.product_id}, this.value)"
                        class="text-xs border border-slate-300 rounded px-2 py-1.5 bg-white text-slate-700">
                        <option value="Physical Recount" ${it.reason_code === 'Physical Recount' ? 'selected' : ''}>Recount</option>
                        <option value="Damaged" ${it.reason_code === 'Damaged' ? 'selected' : ''}>Damaged / Defect</option>
                        <option value="Shrinkage" ${it.reason_code === 'Shrinkage' ? 'selected' : ''}>Shrinkage</option>
                      </select>
                    ` : `
                      <span class="font-bold text-xs text-slate-900">${currentCount} counted</span>
                    `}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="text-rose-600 text-xs text-center py-6">${err.message}</p>`;
    }
  };

  const recordCountItem = async (cycleCountId, productId, countedQty) => {
    try {
      await api(`/api/inventory/cycle-counts/${cycleCountId}/items`, {
        method: 'POST',
        body: JSON.stringify({
          productId,
          countedQty: parseInt(countedQty, 10)
        })
      });
      showToast('Count recorded!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const recordCountReason = async (cycleCountId, productId, reasonCode) => {
    try {
      await api(`/api/inventory/cycle-counts/${cycleCountId}/items`, {
        method: 'POST',
        body: JSON.stringify({
          productId,
          reasonCode
        })
      });
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const approveCycleCount = async (cycleCountId) => {
    try {
      await api(`/api/inventory/cycle-counts/${cycleCountId}/approve`, {
        method: 'POST'
      });
      showToast('Cycle count successfully approved and stock adjusted!', 'success');
      openCycleCountDetail(cycleCountId);
      loadInventory();
      loadOverviewData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ──────────────────────────────────────────
  // Settings & Governance Management
  // ──────────────────────────────────────────
  const toggleSidebar = () => {
    const sidebar = $('appSidebar');
    const icon = $('sidebarToggleIcon');
    if (!sidebar) return;
    const isCollapsed = sidebar.classList.toggle('collapsed');
    if (icon) icon.textContent = isCollapsed ? '»' : '«';
  };

  const exportCsv = (type) => {
    let endpoint = '/api/data/export/catalog';
    if (type === 'orders') endpoint = '/api/data/export/orders';
    if (type === 'movements' || type === 'ledger') endpoint = '/api/data/export/movements';
    window.location.href = endpoint;
  };

  const unarchiveProduct = async (productId) => {
    try {
      await api(`/api/inventory/products/${productId}/unarchive`, { method: 'POST' });
      showToast('Product successfully restored!', 'success');
      loadInventory();
      loadOverviewData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const openProfileModal = async () => {
    try {
      const res = await api('/api/profile', { silent: true }).catch(() => null);
      const user = res?.user || state.user || {};
      if ($('profileFullName')) $('profileFullName').value = user.name || '';
      if ($('profileEmail')) $('profileEmail').value = user.email || '';
      if ($('profilePassword')) $('profilePassword').value = '';
      if ($('profileRoleBadge')) $('profileRoleBadge').textContent = user.role || 'OWNER';
      openModal('profileModal');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const saveProfile = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        name: $('profileFullName').value.trim(),
        email: $('profileEmail').value.trim()
      };
      const pw = $('profilePassword').value;
      if (pw && pw.trim()) payload.password = pw.trim();

      const res = await api('/api/profile', { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Profile updated successfully!', 'success');
      closeModal('profileModal');
      if (res?.user) {
        state.user = res.user;
        if ($('userNameLabel')) $('userNameLabel').textContent = res.user.name || res.user.email;
        if ($('userEmailLabel')) $('userEmailLabel').textContent = res.user.email;
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const toggleOnboardingBanner = () => {
    const grid = $('onboardingStepsGrid');
    const text = $('onboardingToggleText');
    if (!grid) return;
    const isHidden = grid.classList.toggle('hidden');
    if (text) text.textContent = isHidden ? 'Expand ▼' : 'Collapse ▲';
  };

  const updateOnboardingProgress = async () => {
    try {
      const [pos, contacts, purchases, sales] = await Promise.all([
        api('/api/inventory/positions', { silent: true }).catch(() => []),
        api('/api/contacts', { silent: true }).catch(() => []),
        api('/api/orders?type=PURCHASE', { silent: true }).catch(() => []),
        api('/api/orders?type=SALE', { silent: true }).catch(() => [])
      ]);

      const step1Done = Boolean(state.business && (state.business.operatingCashCents || 0) > 0);
      const step2Done = Boolean(contacts && contacts.length > 0);
      const step3Done = Boolean(pos && pos.length > 0);
      const step4Done = Boolean(purchases && purchases.length > 0);
      const step5Done = Boolean(sales && sales.length > 0);

      const steps = [step1Done, step2Done, step3Done, step4Done, step5Done];
      const completedCount = steps.filter(Boolean).length;
      const pct = Math.round((completedCount / 5) * 100);

      const badge = $('onboardingProgressBadge');
      if (badge) badge.textContent = `${completedCount} of 5 Completed (${pct}%)`;

      const updateStepUi = (num, done) => {
        const icon = $(`step${num}Icon`);
        const status = $(`step${num}Status`);
        if (icon) icon.innerHTML = done ? '✓' : String(num);
        if (status) {
          status.textContent = done ? 'Completed' : 'Pending';
          status.className = `text-[10px] font-semibold ${done ? 'text-emerald-300' : 'text-slate-300'}`;
        }
      };

      updateStepUi(1, step1Done);
      updateStepUi(2, step2Done);
      updateStepUi(3, step3Done);
      updateStepUi(4, step4Done);
      updateStepUi(5, step5Done);
    } catch (e) {
      console.warn('onboarding progress check error:', e);
    }
  };

  const loadSettings = async () => {
    try {
      const [res, team] = await Promise.all([
        api('/api/settings', { silent: true }).catch(() => api('/api/auth/settings', { silent: true }).catch(() => null)),
        api('/api/auth/users', { silent: true }).catch(() => [])
      ]);

      const settings = res?.settings || res;
      if (settings) {
        if ($('setBizName')) $('setBizName').value = settings.name || settings.business_name || '';
        if ($('setBizCurrency')) $('setBizCurrency').value = settings.currency || 'USD';
        if ($('setTimezone')) $('setTimezone').value = settings.timezone || 'UTC';
        if ($('setOperatingCash')) $('setOperatingCash').value = ((settings.operatingCashCents ?? settings.operating_cash_cents ?? 0) / 100).toFixed(2);
        if ($('setCashReserve')) $('setCashReserve').value = ((settings.cashReserveCents ?? settings.cash_reserve_cents ?? 0) / 100).toFixed(2);
        if ($('setApprovalThreshold')) $('setApprovalThreshold').value = Math.round((settings.approvalThresholdCents ?? settings.approval_threshold_cents ?? 50000) / 100);
        if ($('setDefaultLeadDays')) $('setDefaultLeadDays').value = settings.defaultLeadDays ?? settings.default_lead_days ?? 7;
        if ($('setDefaultTermsDays')) $('setDefaultTermsDays').value = settings.defaultPaymentTermsDays ?? settings.default_payment_terms_days ?? 30;
      }

      renderTeamMembers(team || []);
    } catch (err) {
      console.error('loadSettings error:', err);
    }
  };

  const saveBusinessSettings = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        name: $('setBizName').value.trim(),
        currency: $('setBizCurrency').value,
        timezone: $('setTimezone')?.value?.trim() || 'UTC',
        operating_cash_cents: Math.round(parseFloat($('setOperatingCash').value || 0) * 100),
        cash_reserve_cents: Math.round(parseFloat($('setCashReserve').value || 0) * 100),
        approval_threshold_cents: Math.round(parseFloat($('setApprovalThreshold').value || 0) * 100),
        default_lead_days: parseInt($('setDefaultLeadDays').value, 10),
        default_payment_terms_days: parseInt($('setDefaultTermsDays').value, 10)
      };

      try {
        await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload), silent: true });
      } catch (postErr) {
        const isCurrReq = postErr.code === 'CURRENCY_CHANGE_CONFIRMATION_REQUIRED' || postErr.data?.code === 'CURRENCY_CHANGE_CONFIRMATION_REQUIRED';
        if (isCurrReq) {
          if (confirm(postErr.message || postErr.data?.message || 'Confirm changing operating currency?')) {
            payload.confirm_currency_change = true;
            await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
          } else {
            return;
          }
        } else {
          showToast(postErr.message || 'Failed to save business settings', 'error');
          return;
        }
      }

      showToast('Business governance settings saved successfully!', 'success');
      loadOverviewData();
      loadSettings();
    } catch (err) {
      console.warn('saveBusinessSettings catch:', err);
    }
  };

  const toggleUserStatus = async (userId, newStatus) => {
    try {
      await api(`/api/auth/users/${userId}/status`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: newStatus ? 1 : 0 })
      });
      showToast(`User status updated to ${newStatus ? 'Active' : 'Deactivated'}!`, 'success');
      const team = await api('/api/auth/users', { silent: true });
      renderTeamMembers(team || []);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const renderTeamMembers = (users) => {
    const container = $('teamUsersContainer');
    if (!container) return;

    if (!Array.isArray(users) || users.length === 0) {
      container.innerHTML = '<div class="p-3 text-xs text-slate-400 text-center">No team members loaded.</div>';
      return;
    }

    container.innerHTML = users.map((u) => {
      const role = u.role || 'PURCHASING';
      let roleBadge = 'bg-blue-50 text-blue-700 border-blue-200';
      if (role === 'OWNER') roleBadge = 'bg-purple-50 text-purple-700 border-purple-200';
      if (role === 'WAREHOUSE') roleBadge = 'bg-amber-50 text-amber-700 border-amber-200';

      const isActive = u.is_active !== undefined ? Boolean(u.is_active) : true;
      const statusBadge = isActive
        ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Active</span>'
        : '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">Deactivated</span>';

      const isMe = state.user && state.user.id === u.id;
      const canToggle = !isMe && state.user?.role === 'OWNER';

      return `
        <div class="p-3 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="text-xs font-bold text-slate-800 truncate">${u.name || u.email} ${isMe ? '<span class="text-[10px] font-normal text-indigo-600">(You)</span>' : ''}</p>
            <p class="text-[10px] text-slate-500 truncate">${u.email}</p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider ${roleBadge}">
              ${role}
            </span>
            ${statusBadge}
            ${canToggle ? `
              <button onclick="App.toggleUserStatus(${u.id}, ${!isActive})" title="${isActive ? 'Deactivate user' : 'Reactivate user'}" class="px-2 py-1 text-[10px] font-semibold rounded border ${isActive ? 'border-rose-200 text-rose-700 hover:bg-rose-50' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'} transition">
                ${isActive ? 'Deactivate' : 'Activate'}
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  };

  const openAddTeamModal = () => {
    if ($('newUserName')) $('newUserName').value = '';
    if ($('newUserEmail')) $('newUserEmail').value = '';
    if ($('newUserPassword')) $('newUserPassword').value = '';
    openModal('addTeamModal');
  };

  const submitAddTeam = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        name: $('newUserName').value.trim(),
        email: $('newUserEmail').value.trim(),
        password: $('newUserPassword').value,
        role: $('newUserRole').value
      };
      await api('/api/auth/users', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Team member added successfully!', 'success');
      closeModal('addTeamModal');
      const team = await api('/api/auth/users', { silent: true });
      renderTeamMembers(team || []);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Capital Limits Modal
  const openCapitalModal = () => {
    if (state.business) {
      if ($('capOperatingCash')) $('capOperatingCash').value = ((state.business.operatingCashCents || 0) / 100).toFixed(0);
      if ($('capCashReserve')) $('capCashReserve').value = ((state.business.cashReserveCents || 0) / 100).toFixed(0);
    }
    openModal('capitalModal');
  };

  const submitCapital = async (e) => {
    e.preventDefault();
    const opDollars = parseFloat($('capOperatingCash').value) || 0;
    const resDollars = parseFloat($('capCashReserve').value) || 0;

    try {
      await api('/api/auth/settings/capital', {
        method: 'POST',
        body: JSON.stringify({
          operatingCashCents: Math.round(opDollars * 100),
          cashReserveCents: Math.round(resDollars * 100)
        })
      });

      showToast('Capital limits updated!', 'success');
      closeModal('capitalModal');
      loadInitialData();
    } catch (err) {
      console.error(err);
    }
  };

  // ──────────────────────────────────────────
  // Vanguard / Smart Copilot AI Assistant
  // ──────────────────────────────────────────
  let copilotMode = 'instant'; // 'instant' | 'llm'
  let llmWorker = null;
  let llmWorkerStatus = 'uninitialized'; // 'uninitialized' | 'downloading' | 'ready' | 'fallback'
  let copilotHistory = [];

  const toggleCopilot = (open) => {
    const drawer = $('copilotDrawer');
    const backdrop = $('copilotBackdrop');
    if (!drawer) return;

    if (open) {
      drawer.classList.remove('translate-x-full');
      if (backdrop) backdrop.classList.remove('hidden');
      setTimeout(() => {
        $('copilotInput')?.focus();
      }, 150);
    } else {
      drawer.classList.add('translate-x-full');
      if (backdrop) backdrop.classList.add('hidden');
    }
  };

  const setCopilotMode = (mode) => {
    copilotMode = mode;
    const btnInstant = $('copilotModeInstant');
    const btnLlm = $('copilotModeLlm');
    const statusBox = $('copilotLlmStatus');

    if (mode === 'instant') {
      if (btnInstant) btnInstant.className = 'px-3.5 py-1.5 rounded-lg font-bold bg-white text-indigo-700 shadow-2xs transition';
      if (btnLlm) btnLlm.className = 'px-3.5 py-1.5 rounded-lg font-semibold text-slate-600 hover:text-slate-900 transition';
      if (statusBox) statusBox.classList.add('hidden');
    } else {
      if (btnLlm) btnLlm.className = 'px-3.5 py-1.5 rounded-lg font-bold bg-indigo-600 text-white shadow-2xs transition';
      if (btnInstant) btnInstant.className = 'px-3.5 py-1.5 rounded-lg font-semibold text-slate-600 hover:text-slate-900 transition';
      if (statusBox) statusBox.classList.remove('hidden');

      initLlmWorker();
    }
  };

  const initLlmWorker = () => {
    if (llmWorker) return;
    try {
      llmWorker = new Worker('/js/llm-worker.js', { type: 'module' });
      llmWorkerStatus = 'downloading';

      llmWorker.onmessage = (e) => {
        const { type, status, data, message } = e.data || {};

        if (type === 'status') {
          llmWorkerStatus = status;
          if ($('copilotLlmStatusText')) {
            $('copilotLlmStatusText').textContent = message || `Status: ${status}`;
          }
          if (status === 'ready') {
            if ($('copilotLlmProgressBar')) $('copilotLlmProgressBar').style.width = '100%';
            if ($('copilotLlmProgressPercent')) $('copilotLlmProgressPercent').textContent = '100%';
            setTimeout(() => {
              $('copilotLlmStatus')?.classList.add('hidden');
            }, 3000);
          }
        } else if (type === 'progress') {
          if (data && typeof data.progress === 'number') {
            const pct = Math.round(data.progress);
            if ($('copilotLlmProgressBar')) $('copilotLlmProgressBar').style.width = `${pct}%`;
            if ($('copilotLlmProgressPercent')) $('copilotLlmProgressPercent').textContent = `${pct}%`;
            if ($('copilotLlmStatusText')) $('copilotLlmStatusText').textContent = `Downloading ${data.file || 'weights'} (${pct}%)...`;
          }
        }
      };

      llmWorker.postMessage({ type: 'init' });
    } catch (workerErr) {
      console.warn('Could not launch LLM Web Worker, defaulting to Real-Time Ledger:', workerErr);
      llmWorkerStatus = 'fallback';
      if ($('copilotLlmStatusText')) $('copilotLlmStatusText').textContent = 'Falling back to Real-Time Ledger Engine';
    }
  };

  const askCopilotPrompt = (promptText) => {
    if (!promptText) return;
    toggleCopilot(true);
    if ($('copilotInput')) {
      $('copilotInput').value = promptText;
      handleCopilotSubmit();
    }
  };

  const formatMarkdown = (text) => {
    if (!text) return '';
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    html = html.replace(/^### (.*$)/gim, '<h4 class="font-bold text-slate-900 text-sm mt-3 mb-1.5">$1</h4>');
    html = html.replace(/^#### (.*$)/gim, '<h5 class="font-bold text-slate-800 text-xs mt-2 mb-1">$1</h5>');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/^\> (.*$)/gim, '<blockquote class="border-l-3 border-indigo-500 pl-3 py-1 my-2 bg-indigo-50/50 rounded-r-lg text-slate-700 italic text-xs">$1</blockquote>');

    if (html.includes('|')) {
      const lines = html.split('\n');
      const tableLines = [];
      let inTable = false;
      const newLines = [];

      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (l.startsWith('|') && l.endsWith('|')) {
          if (!inTable) {
            inTable = true;
            newLines.push('<div class="overflow-x-auto my-3 rounded-xl border border-slate-200 shadow-2xs bg-white"><table class="w-full text-left text-xs border-collapse">');
          }
          if (l.includes('---')) continue;
          const cells = l.split('|').slice(1, -1).map((c) => c.trim());
          const isHeader = !tableLines.length;
          tableLines.push(l);
          const tag = isHeader ? 'th' : 'td';
          const bg = isHeader ? 'bg-slate-100 font-bold text-slate-800 border-b border-slate-200' : 'hover:bg-indigo-50/40 border-b border-slate-100 last:border-b-0 text-slate-700';
          newLines.push(`<tr class="${bg}">${cells.map((c) => `<${tag} class="px-3 py-2 border-r border-slate-200 last:border-r-0 whitespace-nowrap">${c}</${tag}>`).join('')}</tr>`);
        } else {
          if (inTable) {
            inTable = false;
            newLines.push('</table></div>');
          }
          newLines.push(lines[i]);
        }
      }
      if (inTable) newLines.push('</table></div>');
      html = newLines.join('\n');
    }

    html = html.replace(/^\s*-\s+(.*$)/gim, '<li class="ml-4 list-disc my-1 leading-relaxed">$1</li>');
    html = html.replace(/\n{2,}/g, '<div class="h-2"></div>');

    return html;
  };

  const generateClientSideGroundedAnswer = (question, mode = 'ledger') => {
    const qLower = (question || '').toLowerCase().trim();
    const currSym = state.metrics?.currency === 'EUR' ? '€' : (state.metrics?.currency === 'GBP' ? '£' : '$');
    const prods = state.products || [];
    const m = state.metrics || {};
    const b = state.business || {};
    const isReasoning = mode === 'reasoning' || mode === 'llm';

    const safeBudgetCents = m.freeWorkingCapitalCents ?? 0;
    const opCashCents = m.operatingCashCents ?? 0;
    const reserveCents = m.cashReserveCents ?? 0;
    const payablesCents = m.upcoming14dApCents ?? 0;
    const receivablesCents = m.arOutstandingCents ?? 0;

    const safeBudgetFormatted = `${currSym}${(safeBudgetCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const opCashFormatted = `${currSym}${(opCashCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const reserveFormatted = `${currSym}${(reserveCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const payablesFormatted = `${currSym}${(payablesCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const receivablesFormatted = `${currSym}${(receivablesCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

    const criticalList = prods.filter((p) => (p.available ?? p.on_hand ?? 0) <= (p.min_safety_stock || 0));

    // 1. Specific SKU / Product mentioned
    const mentionedProd = prods.find((p) =>
      (p.sku && qLower.includes(p.sku.toLowerCase())) ||
      (p.name && qLower.includes(p.name.toLowerCase()))
    );

    if (mentionedProd) {
      const onHand = mentionedProd.on_hand ?? 0;
      const avail = mentionedProd.available ?? onHand;
      const isCrit = avail <= (mentionedProd.min_safety_stock || 0);

      if (!isReasoning) {
        return {
          groundedAnswer: [
            `### Product Dossier: **${mentionedProd.sku}** (${mentionedProd.name})`,
            `- **Category:** ${mentionedProd.category || 'General'}`,
            `- **Physical On-Hand:** **${onHand}** ${mentionedProd.base_unit || 'pcs'}`,
            `- **Reserved (Sales Orders):** **${mentionedProd.reserved ?? 0}** units`,
            `- **Net Available Stock:** **${avail}** units`,
            `- **Inbound Purchase Orders:** **${mentionedProd.incoming_po ?? 0}** units`,
            `- **Safety Stock Ceiling:** **${mentionedProd.min_safety_stock ?? 0}** units (Lead Time: **${mentionedProd.lead_days ?? 7}** days)`,
            `- **Unit Pricing:** Cost **${currSym}${((mentionedProd.cost_price_cents || 0) / 100).toFixed(2)}** | Sell **${currSym}${((mentionedProd.sell_price_cents || 0) / 100).toFixed(2)}**`,
            '',
            isCrit
              ? `⚠️ **Restock Alert:** Net available stock is at or below minimum safety stock. Replenishment purchase order recommended.`
              : `✅ **Stock Status:** Healthy inventory balance covering lead time commitments.`
          ].join('\n'),
          sources: ['Catalog & Product Ledger'],
          suggestedActions: [
            { label: 'View in Catalog', tab: 'inventory' },
            { label: 'Adjust Stock Count', action: 'openAdjustForSku', sku: mentionedProd.sku },
            { label: 'Create Purchase Order', action: 'newPo' }
          ]
        };
      } else {
        const costDol = ((mentionedProd.cost_price_cents || 0) / 100);
        const sellDol = ((mentionedProd.sell_price_cents || 0) / 100);
        const marginPct = sellDol > 0 ? (((sellDol - costDol) / sellDol) * 100).toFixed(1) : '0.0';

        return {
          groundedAnswer: [
            `### 🧠 Strategic SKU Analysis: **${mentionedProd.sku}**`,
            `**Diagnostic Overview:**`,
            `Holds **${onHand}** units on-hand with **${mentionedProd.reserved ?? 0}** units committed to sales orders, leaving **${avail}** available for sale.`,
            '',
            `**Supply Risk & Vulnerabilities:**`,
            `- **Vendor Lead Time:** **${mentionedProd.lead_days ?? 7} days** replenishment cycle.`,
            `- **Buffer Status:** Safety target is **${mentionedProd.min_safety_stock ?? 0} units**. ${isCrit ? `🚨 Deficit detected! Available inventory (${avail}) cannot absorb demand surges.` : `🟢 Sound coverage over lead-time delivery.`}`,
            `- **Unit Economics:** Cost: ${currSym}${costDol.toFixed(2)} | Sell: ${currSym}${sellDol.toFixed(2)} (${marginPct}% gross margin).`,
            '',
            `**Actionable Recommendations:**`,
            `1. ${isCrit ? `Approve a Purchase Order for this item immediately to beat the ${mentionedProd.lead_days ?? 7}-day lead time.` : `Maintain regular reorder cycles.`}`,
            `2. Monitor incoming POs (**${mentionedProd.incoming_po ?? 0}** inbound) to ensure timely warehouse receiving.`,
            `3. Reconcile cycle counts if physical count deviates from ${onHand} units.`
          ].join('\n'),
          sources: ['Analytical SKU Diagnosis Engine'],
          suggestedActions: [
            { label: 'Create Purchase Order', action: 'newPo' },
            { label: 'Adjust Stock Count', action: 'openAdjustForSku', sku: mentionedProd.sku }
          ]
        };
      }
    }

    // 2. Today's Priorities & Daily Operational Focus
    if (
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
      const pos = state.purchaseOrders || [];
      const drafts = pos.filter((p) => p.status === 'DRAFT');

      if (!isReasoning) {
        return {
          groundedAnswer: [
            `### 📅 Today's Operational Ledger & Pending Actions`,
            `- **Safe Purchasing Capacity:** **${safeBudgetFormatted}** (Available Cash: **${opCashFormatted}**, Reserve Floor: **${reserveFormatted}**)`,
            `- **Stockout Exposure:** **${criticalList.length}** critical SKU(s) breached safety buffer.`,
            `- **Pending Procurement Drafts:** **${drafts.length}** draft PO(s) waiting for approval.`,
            '',
            `| Order / Action | Type | Total / Impact | Required Next Step |`,
            `| :--- | :---: | :---: | :--- |`,
            drafts.length > 0 ? drafts.map((d) => `| **#${d.order_number}** | Draft PO | ${currSym}${((d.total_cents || 0) / 100).toFixed(2)} | Review line items & Approve to notify vendor |`).join('\n') : `| All POs Confirmed | Clean | $0.00 | No pending draft POs awaiting review |`,
            criticalList.length > 0 ? criticalList.map((c) => `| **${c.sku}** | Stockout Risk | ${c.available ?? c.on_hand ?? 0} left (Safety: ${c.min_safety_stock || 0}) | Generate replenishment PO |`).join('\n') : `| Stock Health | Optimal | 0 Deficits | All inventory balances above safety buffer |`,
            '',
            `> **Today's Operational Guideline:** Review draft POs and verify they fit within your **${safeBudgetFormatted}** safe-to-spend limit before approving.`
          ].join('\n'),
          sources: ['Operational Workflow Engine', 'Daily Action Queue'],
          suggestedActions: [
            { label: 'Review Purchasing (PO)', tab: 'purchases' },
            { label: 'Demand Planning', tab: 'insights' },
            { label: 'Catalog & Inventory', tab: 'inventory' }
          ]
        };
      } else {
        const largeDrafts = drafts.filter((d) => (d.total_cents || 0) > safeBudgetCents);
        return {
          groundedAnswer: [
            `### 🧠 Executive Operational Briefing: Today's Strategic Focus`,
            `**Diagnostic Analysis for Today:**`,
            drafts.length > 0
              ? `You have **${drafts.length} draft purchase orders** awaiting commercial authorization.`
              : `Your purchase order pipeline is clear with zero pending draft orders.`,
            '',
            largeDrafts.length > 0
              ? `🚨 **Critical Budget Warning for Today:**\n` +
                largeDrafts.map((d) => `- **PO #${d.order_number}** is drafted for **${currSym}${((d.total_cents || 0) / 100).toFixed(2)}**, which exceeds your safe purchasing budget (**${safeBudgetFormatted}**) by **${currSym}${(((d.total_cents || 0) - safeBudgetCents) / 100).toFixed(2)}**! Approving this order will violate your mandatory **${reserveFormatted}** bank reserve policy.`).join('\n') +
                `\n*Action Required: Resize or split this PO into phased supplier deliveries.*`
              : `✅ All pending draft POs fit comfortably within your verified **${safeBudgetFormatted}** safe purchasing budget.`,
            '',
            `**Inventory & Demand Health Today:**`,
            `- **Stockout Defense:** ${criticalList.length === 0 ? `🟢 Zero SKUs at risk today across ${prods.length} catalog items. Active safety stock is successfully insulating your business from customer order spikes.` : `⚠️ ${criticalList.length} SKU(s) have breached safety thresholds. Prioritize replenishment.`}`,
            `- **Liquid Headroom:** Operating cash stands at **${opCashFormatted}** with **${reserveFormatted}** protected reserve floor.`,
            '',
            `**Prioritized 3-Step Action Plan for Today:**`,
            `1. **Procurement Review:** Open the **Purchasing (PO)** tab, inspect the ${drafts.length} draft PO(s), and adjust quantities to respect capital limits.`,
            `2. **Warehouse Receiving:** Ensure dock staff check in any in-transit freight to keep on-hand inventory live and accurate.`,
            `3. **Demand Forecast Synchronization:** Run the Demand Planning ML pipeline to refresh 30-day quantile regression curves.`
          ].join('\n'),
          sources: ['Executive Operational Advisory'],
          suggestedActions: [
            { label: 'Review Purchasing (PO)', tab: 'purchases' },
            { label: 'Demand Planning', tab: 'insights' },
            { label: 'Catalog & Inventory', tab: 'inventory' }
          ]
        };
      }
    }

    // 2. Stockout Risks & Replenishment Alerts
    if (
      qLower.includes('risk') ||
      qLower.includes('stockout') ||
      qLower.includes('critical') ||
      qLower.includes('shortage') ||
      qLower.includes('restock') ||
      qLower.includes('low stock') ||
      qLower.includes('out of stock') ||
      qLower.includes('deficit')
    ) {
      if (!isReasoning) {
        const riskRows = criticalList.map(p => {
          const onHand = p.on_hand ?? 0;
          const avail = p.available ?? onHand;
          return `| **${p.sku}** | ${p.name || p.sku} | **${avail}** | ${p.min_safety_stock || 0} | ${p.incoming_po || 0} | ${p.lead_days || 7}d | ⚠️ Low |`;
        }).join('\n');

        return {
          groundedAnswer: [
            `### Critical Low-Stock SKUs & Stockout Alert`,
            criticalList.length > 0
              ? `There are **${criticalList.length}** active SKU(s) whose net available stock is at or below minimum safety stock buffers.`
              : `All product lines have healthy available inventory covering demand and vendor lead times.`,
            '',
            criticalList.length > 0 ? [
              `| SKU | Product Title | Available | Safety Buffer | Inbound POs | Lead Time | Status |`,
              `| :--- | :--- | :---: | :---: | :---: | :---: | :---: |`,
              riskRows,
              '',
              `> **Operational Priority:** Expedite replenishment purchase orders for critical items to prevent customer fulfillment delays.`
            ].join('\n') : `✅ **Optimal Status:** Zero stockout risks detected across all ${prods.length} catalog products.`
          ].join('\n'),
          sources: ['Stockout Risk Engine', 'Catalog Buffer Ledger'],
          suggestedActions: [
            { label: 'Demand Planning', tab: 'insights' },
            { label: 'Create Purchase Order', action: 'newPo' },
            { label: 'View Inventory Catalog', tab: 'inventory' }
          ]
        };
      } else {
        return {
          groundedAnswer: [
            `### 🧠 Executive Stockout Risk & Replenishment Diagnostic`,
            `**Risk Severity:**`,
            `**${criticalList.length}** out of ${prods.length} SKUs have breached safety buffers and require purchase intervention.`,
            '',
            `**Vulnerabilities & Exposure:**`,
            criticalList.slice(0, 5).map(c => `- **${c.sku} (${c.name}):** Available = **${c.available ?? c.on_hand ?? 0}** (Safety Buffer: ${c.min_safety_stock || 0}). Lead time is ${c.lead_days || 7} days.`).join('\n'),
            '',
            `**Prioritized Strategic Plan:**`,
            `1. **Generate Purchase Orders:** Navigate to Demand Planning to convert P50 replenishment recommendations into Draft POs.`,
            `2. **Supplier Coordination:** Contact vendors for critical items to lock in priority dispatch.`,
            `3. **Buffer Calibration:** Review if sudden sales velocity requires updating safety stock parameters in Settings.`
          ].join('\n'),
          sources: ['Strategic Supply Chain Advisory'],
          suggestedActions: [
            { label: 'Demand Planning', tab: 'insights' },
            { label: 'Create Purchase Order', action: 'newPo' }
          ]
        };
      }
    }

    // 3. Purchasing Budget & Safe to Spend
    if (
      qLower.includes('purchasing budget') ||
      qLower.includes('safe to spend') ||
      qLower.includes('how much can i spend') ||
      qLower.includes('safe budget') ||
      qLower.includes('spending limit') ||
      qLower.includes('cash reserve') ||
      qLower.includes('capital ceiling') ||
      qLower.includes('budget')
    ) {
      if (!isReasoning) {
        return {
          groundedAnswer: [
            `### Safe-to-Spend Purchasing Budget Policy`,
            `Your organization has **${safeBudgetFormatted}** in verified safe purchasing capital.`,
            '',
            `| Financial Parameter | Amount | Operational Policy |`,
            `| :--- | :--- | :--- |`,
            `| **Available Cash** | **${opCashFormatted}** | Liquid cash across verified business bank accounts |`,
            `| **Mandatory Reserve** | **-${reserveFormatted}** | Liquidity ceiling protected from purchasing commitments |`,
            `| **14-Day Payables** | **-${payablesFormatted}** | Vendor commitments due within 14 days |`,
            `| **Safe Purchasing Budget** | **${safeBudgetFormatted}** | **Net safe capital for replenishment purchase orders** |`,
            '',
            `> **Working Capital Rule:** Draft purchase orders do **not** lock liquidity until approved/confirmed. Once confirmed, commitments are reserved against your capital policy.`,
            '',
            `Additionally, you have **${receivablesFormatted}** in customer accounts receivable across active sales orders.`
          ].join('\n'),
          sources: ['Working Capital Policy', 'Accounts Payable & Receivable Ledger'],
          suggestedActions: [
            { label: 'Review Purchasing (PO)', tab: 'purchases' },
            { label: 'Cash Flow & Payments', tab: 'payments' },
            { label: 'Adjust Capital Reserve', tab: 'settings' }
          ]
        };
      } else {
        return {
          groundedAnswer: [
            `### 🧠 Working Capital & Solvency Advisory`,
            `**Capital Deployment Diagnostic:**`,
            `Total liquid funds: **${opCashFormatted}**. With **${reserveFormatted}** ring-fenced for liquidity safety and **${payablesFormatted}** earmarked for vendor obligations due in 14 days, your safe procurement capacity is **${safeBudgetFormatted}**.`,
            '',
            `**Working Capital Levers:**`,
            `- **Receivables Recovery:** Collecting **${receivablesFormatted}** in open customer AR directly expands purchasing capacity.`,
            `- **PO Commitment Control:** Confirming new POs commits cash; keep commitments strictly under ${safeBudgetFormatted}.`,
            '',
            `**Treasury Action Plan:**`,
            `1. Keep total approved PO commitments within ${safeBudgetFormatted}.`,
            `2. Follow up on customer overdue invoices to accelerate cash flow into liquid operating accounts.`,
            `3. Re-evaluate cash reserve threshold under Settings if seasonal demand spikes require extra purchasing capital.`
          ].join('\n'),
          sources: ['Executive Capital Advisory'],
          suggestedActions: [
            { label: 'Review Purchasing (PO)', tab: 'purchases' },
            { label: 'Payments & Cash Flow', tab: 'payments' }
          ]
        };
      }
    }

    // 4. Purchase Orders (POs) & Inbound Pipeline
    if (
      qLower.includes('purchase order') ||
      qLower.includes('purchase orders') ||
      qLower.includes('draft po') ||
      qLower.includes('open po') ||
      /\bpos?\b/i.test(qLower) ||
      qLower.includes('procurement') ||
      qLower.includes('inbound order') ||
      qLower.includes('buy order')
    ) {
      if (!isReasoning) {
        return {
          groundedAnswer: [
            `### Purchase Orders (PO) & Inbound Pipeline`,
            `- **Safe Purchasing Capacity:** **${safeBudgetFormatted}** safe capital for new POs`,
            `- **Upcoming 14-Day Vendor AP:** **${payablesFormatted}**`,
            '',
            `> **Procurement Workflow:**`,
            `1. Click **+ Create** → **New Purchase Order** or click **Generate Draft PO** in Demand Planning.`,
            `2. Draft POs do **not** lock cash until approved. Once approved, expected inbound quantities register across catalog balances.`,
            `3. Receive items at the warehouse dock via the **Receive Inbound Items** modal.`
          ].join('\n'),
          sources: ['Purchase Orders Management Subsystem'],
          suggestedActions: [
            { label: 'View Purchase Orders', tab: 'purchases' },
            { label: 'Create Purchase Order', action: 'newPo' },
            { label: 'Demand Planning', tab: 'insights' }
          ]
        };
      } else {
        return {
          groundedAnswer: [
            `### 🧠 Procurement & Inbound Supply Chain Reasoning`,
            `**Pipeline Health Assessment:**`,
            `Purchasing commitments are guarded by your **${safeBudgetFormatted}** safe-to-spend policy ceiling.`,
            '',
            `**Supplier Coordination Advisory:**`,
            `- Check vendor lead times before approving POs to avoid stockout gaps.`,
            `- Unapproved Draft POs remain visible to buyers but do not notify suppliers or hold inventory allocations.`,
            '',
            `**Operational Action Plan:**`,
            `1. Review pending Draft POs and click Approve to trigger supplier fulfillment.`,
            `2. Prepare warehouse receiving bays for incoming shipments.`,
            `3. Reconcile received quantities against vendor invoices to safeguard against overbilling.`
          ].join('\n'),
          sources: ['Procurement Decision Intelligence'],
          suggestedActions: [
            { label: 'Purchasing (PO)', tab: 'purchases' },
            { label: 'Create Purchase Order', action: 'newPo' }
          ]
        };
      }
    }

    // 5. Sales Orders, Customer Demand & Revenue
    if (
      qLower.includes('sales order') ||
      qLower.includes('sales orders') ||
      qLower.includes('sales') ||
      qLower.includes('revenue') ||
      qLower.includes('customer order') ||
      qLower.includes('dispatch') ||
      qLower.includes('fulfillment') ||
      qLower.includes('fulfill') ||
      qLower.includes('open sales')
    ) {
      if (!isReasoning) {
        return {
          groundedAnswer: [
            `### Sales Orders & Customer Demand Register`,
            `- **Open Customer Accounts Receivable:** **${receivablesFormatted}**`,
            `- **Active Catalog Products:** **${prods.length}** SKUs`,
            '',
            `> **Order Reservation Governance:**`,
            `- When a Sales Order is approved, physical stock is reserved immediately to prevent overselling.`,
            `- Fulfillment deducts reserved stock and registers invoice receivables in your cash ledger.`
          ].join('\n'),
          sources: ['Sales Orders Subsystem', 'Customer Demand Register'],
          suggestedActions: [
            { label: 'View Sales Orders', tab: 'sales' },
            { label: 'Cash Flow & Payments', tab: 'payments' },
            { label: 'Inventory Catalog', tab: 'inventory' }
          ]
        };
      } else {
        return {
          groundedAnswer: [
            `### 🧠 Sales Demand & Revenue Optimization Diagnostic`,
            `**Commercial Revenue Health:**`,
            `Your wholesale operation holds **${receivablesFormatted}** in uncollected customer receivables across active deliveries.`,
            '',
            `**Fulfillment Recommendations:**`,
            `1. Expedite dispatch on confirmed orders where physical available stock is ready in warehouse bins.`,
            `2. Monitor customer payment terms to prevent aged receivables from eroding operating liquidity.`,
            `3. Check low-stock alerts before confirming backorders to avoid fulfillment bottlenecks.`
          ].join('\n'),
          sources: ['Revenue Cycle Intelligence'],
          suggestedActions: [
            { label: 'Sales Orders', tab: 'sales' },
            { label: 'Payments & Receivables', tab: 'payments' }
          ]
        };
      }
    }

    // 6. Suppliers & Vendors
    if (
      qLower.includes('supplier') ||
      qLower.includes('suppliers') ||
      qLower.includes('vendor') ||
      qLower.includes('vendors')
    ) {
      return {
        groundedAnswer: [
          `### Wholesale Suppliers & Vendor Directory`,
          `Your supplier contacts govern vendor lead times, payment terms, and automated draft purchase orders.`,
          '',
          `- **Default Payment Terms:** Standard net-30 vendor policy.`,
          `- **Lead Time Default:** **${b.defaultLeadDays || 7} days** turnaround.`,
          '',
          `> Manage vendor profiles, email contacts, and phone numbers in the **Suppliers & Customers** tab.`
        ].join('\n'),
        sources: ['Contacts Directory', 'Vendor Governance Policy'],
        suggestedActions: [
          { label: 'Manage Suppliers', tab: 'contacts' },
          { label: 'Purchasing (PO)', tab: 'purchases' }
        ]
      };
    }

    // 7. Customers & Accounts Receivable
    if (
      qLower.includes('customer') ||
      qLower.includes('customers') ||
      qLower.includes('client') ||
      qLower.includes('clients') ||
      qLower.includes('buyer')
    ) {
      return {
        groundedAnswer: [
          `### Wholesale Customers & Accounts Receivable`,
          `- **Outstanding Customer AR:** **${receivablesFormatted}** awaiting invoice settlement.`,
          `- **Default Terms:** Net-30 wholesale payment agreements.`,
          '',
          `> Record payments, manage credit limits, and add customer profiles in the **Suppliers & Customers** tab.`
        ].join('\n'),
        sources: ['Customer Directory', 'Accounts Receivable Register'],
        suggestedActions: [
          { label: 'Customers Directory', tab: 'contacts' },
          { label: 'Payments & Cash Flow', tab: 'payments' }
        ]
      };
    }

    // 8. Cash Flow, Payments & Liquidity
    if (
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
      qLower.includes('liquid cash')
    ) {
      return {
        groundedAnswer: [
          `### Verified Cash Position & Payment Ledger`,
          `- **Verified Liquid Bank Cash:** **${opCashFormatted}**`,
          `- **Mandatory Policy Reserve:** **${reserveFormatted}** (Untouchable floor)`,
          `- **14-Day Upcoming Supplier Payables (AP):** **${payablesFormatted}**`,
          `- **Customer Accounts Receivable (AR):** **${receivablesFormatted}**`,
          `- **Net Safe-to-Spend Purchasing Capital:** **${safeBudgetFormatted}**`,
          '',
          `| Flow Direction | Parameter | Value | Ledger Status |`,
          `| :--- | :--- | :---: | :--- |`,
          `| 🟢 Inflow Pending | Customer AR | **${receivablesFormatted}** | Unpaid invoices |`,
          `| 🔴 Outflow Near-Term | 14-Day Vendor AP | **${payablesFormatted}** | Due within 14 days |`,
          `| 🛡️ Shielded Buffer | Capital Reserve | **${reserveFormatted}** | Board-approved floor |`,
          `| ⚡ Free Headroom | Safe Budget | **${safeBudgetFormatted}** | **Safe to procure now** |`
        ].join('\n'),
        sources: ['Cash Flow & Balance Register'],
        suggestedActions: [
          { label: 'Payments & Cash Flow', tab: 'payments' },
          { label: 'Purchasing (PO)', tab: 'purchases' }
        ]
      };
    }

    // 9. ML Demand Forecasts & Replenishment Math
    if (
      qLower.includes('forecast') ||
      qLower.includes('forecasts') ||
      qLower.includes('ml') ||
      qLower.includes('p50') ||
      qLower.includes('p90') ||
      qLower.includes('lightgbm') ||
      qLower.includes('croston') ||
      qLower.includes('sba') ||
      qLower.includes('formula') ||
      qLower.includes('math') ||
      qLower.includes('safety stock') ||
      qLower.includes('predict')
    ) {
      return {
        groundedAnswer: [
          `### Demand Planning & Machine Learning Methodology`,
          `Our replenishment engine eliminates stockouts using statistical forecasting and quantile regression:`,
          '',
          `#### 1. Core Mathematical Formulas`,
          `- **Lead Time Demand ($LTD$):**`,
          `  $$LTD = \\bar{d} \\times L$$`,
          `  where $\\bar{d}$ is average daily sales velocity and $L$ is vendor lead time in days.`,
          `- **Safety Stock Buffer ($SS$):**`,
          `  $$SS = Z \\times \\sigma_d \\times \\sqrt{L}$$`,
          `  where $Z = 1.65$ (enforcing 95% service level) and $\\sigma_d$ is sales standard deviation.`,
          `- **Reorder Point ($ROP$):**`,
          `  $$ROP = LTD + SS$$`,
          '',
          `#### 2. Dual-Engine Model Selection`,
          `- **LightGBM Quantile Regression:** Deployed for steady, seasonal wholesale volume to generate expected demand (**P50**) and high-risk peak demand (**P90**).`,
          `- **Croston & SBA (Syntetos-Boylan Approximation):** Automatically activates for sporadic, lumpy items with sales frequency $< 30\\%$ to prevent overstocking.`
        ].join('\n'),
        sources: ['Demand Planning Engine', 'Statistical ML Pipeline'],
        suggestedActions: [
          { label: 'Open Demand Planning', tab: 'insights' },
          { label: 'Run Pipeline', action: 'runPipeline' }
        ]
      };
    }

    // 10. Blind Count & Audits
    if (
      qLower.includes('blind count') ||
      qLower.includes('audit') ||
      qLower.includes('variance') ||
      qLower.includes('discrepancy') ||
      qLower.includes('physical count') ||
      qLower.includes('recount') ||
      qLower.includes('cycle count')
    ) {
      const thresholdDollars = ((b.approvalThresholdCents || 50000) / 100).toFixed(2);
      return {
        groundedAnswer: [
          `### Physical Inventory Cycle Count & Blind Audit Guide`,
          `The application enforces disciplined physical counting to maintain 99%+ inventory accuracy:`,
          '',
          `1. **Blind Count Mode (Eliminating Bias):**`,
          `   - System expected quantities are **hidden** from counting personnel.`,
          `   - Warehouse staff must independently count physical stock without preconception.`,
          '',
          `2. **Monetary Variance Approval Ceiling:**`,
          `   - When counted quantity differs from system balance, discrepancy value is calculated.`,
          `   - If absolute variance exceeds **${currSym}${thresholdDollars}**, changes require **OWNER** authorization before stock adjustments post.`,
          `   - Verified recounts match seamlessly into the stock movement ledger.`
        ].join('\n'),
        sources: ['Cycle Count Subsystem', 'Governance & Audit Log'],
        suggestedActions: [
          { label: 'Open Cycle Count Audits', action: 'openCycleCount' },
          { label: 'Configure Approval Limit', tab: 'settings' }
        ]
      };
    }

    // 11. Profit Margins & Valuation
    if (
      qLower.includes('profit') ||
      qLower.includes('margin') ||
      qLower.includes('margins') ||
      qLower.includes('markup') ||
      qLower.includes('valuation') ||
      qLower.includes('inventory value')
    ) {
      const totalValuation = prods.reduce((acc, p) => acc + (Math.max(0, p.on_hand || 0) * (p.cost_price_cents || 0)), 0);
      const valFormatted = `${currSym}${(totalValuation / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

      return {
        groundedAnswer: [
          `### Catalog Valuation & Margin Overview`,
          `- **Total Catalog Valuation (at cost):** **${valFormatted}** across **${prods.length}** SKUs`,
          `- **Pricing Policy:** Margin is tracked per SKU comparing unit cost against wholesale selling price.`,
          '',
          `> Review product unit costs and pricing in the **Catalog & Inventory** tab.`
        ].join('\n'),
        sources: ['Inventory Asset Ledger', 'Catalog Pricing'],
        suggestedActions: [
          { label: 'View Inventory Catalog', tab: 'inventory' },
          { label: 'Sales Orders', tab: 'sales' }
        ]
      };
    }

    // 12. Stocks / Inventory lookup (General catalog)
    if (
      qLower.includes('stock') ||
      qLower.includes('stocks') ||
      qLower.includes('inventory') ||
      qLower.includes('item') ||
      qLower.includes('items') ||
      qLower.includes('catalog') ||
      qLower.includes('on hand') ||
      qLower.includes('available') ||
      qLower.includes('count')
    ) {
      const totalValuation = prods.reduce((acc, p) => acc + (Math.max(0, p.on_hand || 0) * (p.cost_price_cents || 0)), 0);
      const valFormatted = `${currSym}${(totalValuation / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

      const itemsTable = prods.slice(0, 8).map((p) => {
        const onHand = p.on_hand ?? 0;
        const avail = p.available ?? onHand;
        const isCrit = avail <= (p.min_safety_stock || 0);
        const nameShort = p.name ? (p.name.length > 22 ? p.name.slice(0, 21) + '…' : p.name) : p.sku;
        return `| **${p.sku}** | ${nameShort} | **${onHand}** | ${p.reserved || 0} | **${avail}** | ${p.min_safety_stock || 0} | ${p.incoming_po || 0} | ${isCrit ? '⚠️ Low' : '✅ Optimal'} |`;
      }).join('\n');

      return {
        groundedAnswer: [
          `### Live Inventory Status & Stock Positions`,
          `- **Total Active SKUs:** **${prods.length}** products`,
          `- **Total Inventory Valuation (at cost):** **${valFormatted}**`,
          `- **Stockout Risks:** **${criticalList.length}** item(s) at or below safety stock threshold.`,
          '',
          `| SKU | Product Title | On-Hand | Reserved | Available | Safety | Inbound | Status |`,
          `| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |`,
          itemsTable,
          '',
          criticalList.length > 0
            ? `⚠️ **Action Required:** ${criticalList.length} SKU(s) have available stock below their safety buffer. Generate replenishment purchase orders.`
            : `✅ **Healthy Stock:** Stock levels across all product lines are currently adequate.`
        ].join('\n'),
        sources: ['Live Inventory Position Engine', 'Stock Movement Ledger'],
        suggestedActions: [
          { label: 'View Full Catalog', tab: 'inventory' },
          { label: 'Demand Planning', tab: 'insights' },
          { label: 'Create Purchase Order', action: 'newPo' }
        ]
      };
    }

    // 13. Default Executive Briefing
    return {
      groundedAnswer: [
        `### Executive Business Briefing: **${b.name || 'Smart Business Analyzer'}**`,
        `- **Safe Purchasing Budget:** **${safeBudgetFormatted}** (Cash: **${opCashFormatted}**, Reserve: **${reserveFormatted}**, 14d AP: **${payablesFormatted}**)`,
        `- **Active Catalog:** **${prods.length}** SKUs with **${criticalList.length}** items currently at risk of stockout.`,
        `- **Accounts Receivable:** **${receivablesFormatted}** awaiting customer settlement.`,
        '',
        `*Ask me about any specific SKU, purchase orders, sales orders, suppliers, purchasing budget rules, or replenishment formulas.*`
      ].join('\n'),
      sources: ['Executive Ledger Summary'],
      suggestedActions: [
        { label: 'View Inventory Catalog', tab: 'inventory' },
        { label: 'Review Purchasing (PO)', tab: 'purchases' },
        { label: 'Demand Planning', tab: 'insights' }
      ]
    };
  };

  const handleCopilotSubmit = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const input = $('copilotInput');
    const question = input?.value?.trim();
    if (!question) return;

    input.value = '';

    appendCopilotMessage('user', question);

    const typing = $('copilotTyping');
    if (typing) typing.classList.remove('hidden');

    try {
      let groundedRes = null;
      const targetMode = copilotMode === 'llm' ? 'reasoning' : 'ledger';

      // 1. Attempt server-side /api/assistant/ask with silent error handling
      try {
        groundedRes = await api('/api/assistant/ask', {
          method: 'POST',
          silent: true,
          body: JSON.stringify({
            question,
            mode: targetMode,
            history: copilotHistory.slice(-6)
          })
        });
      } catch (apiErr) {
        console.warn('Server assistant endpoint unavailable, resolving via client-side live state:', apiErr);
      }

      // 2. Fallback to client-side live state RAG if server returned 404, error, or unhandled
      if (!groundedRes || !groundedRes.groundedAnswer || groundedRes.error) {
        groundedRes = generateClientSideGroundedAnswer(question, targetMode);
      }

      let finalAnswer = groundedRes.groundedAnswer;
      let modelLabel = copilotMode === 'llm' ? '🧠 Smart Reasoning' : '⚡ Real-Time Ledger';

      // 3. If Neural LLM mode selected and worker ready
      if (copilotMode === 'llm' && llmWorker && llmWorkerStatus === 'ready') {
        const reqId = Date.now();
        const llmPromise = new Promise((resolve) => {
          const timeout = setTimeout(() => {
            resolve({ answer: finalAnswer, model: '🧠 Smart Reasoning' });
          }, 8000);

          const listener = (event) => {
            if (event.data?.type === 'result' && event.data.id === reqId) {
              clearTimeout(timeout);
              llmWorker.removeEventListener('message', listener);
              resolve(event.data);
            }
          };
          llmWorker.addEventListener('message', listener);
          llmWorker.postMessage({
            type: 'generate',
            id: reqId,
            question,
            liveContext: groundedRes.liveContext || state,
            groundedAnswer: groundedRes.groundedAnswer
          });
        });

        const llmResult = await llmPromise;
        if (llmResult?.answer) {
          finalAnswer = llmResult.answer;
          modelLabel = '🧠 Smart Reasoning';
        }
      }

      if (typing) typing.classList.add('hidden');

      appendCopilotMessage('assistant', finalAnswer, {
        sources: groundedRes.sources || ['Live Business Ledger'],
        actions: groundedRes.suggestedActions || [],
        model: modelLabel
      });

      copilotHistory.push({ role: 'user', content: question });
      copilotHistory.push({ role: 'assistant', content: finalAnswer });
    } catch (err) {
      if (typing) typing.classList.add('hidden');
      const fallback = generateClientSideGroundedAnswer(question, copilotMode === 'llm' ? 'reasoning' : 'ledger');
      appendCopilotMessage('assistant', fallback.groundedAnswer, {
        sources: fallback.sources,
        actions: fallback.suggestedActions,
        model: copilotMode === 'llm' ? '🧠 Smart Reasoning' : '⚡ Real-Time Ledger'
      });
    }
  };

  const appendCopilotMessage = (role, text, meta = {}) => {
    const container = $('copilotMessages');
    if (!container) return;

    const div = document.createElement('div');
    div.className = 'flex items-start gap-3 transition-opacity duration-200';

    if (role === 'user') {
      div.className += ' justify-end';
      div.innerHTML = `
        <div class="max-w-[85%] bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-4 py-3 text-xs shadow-xs font-medium leading-relaxed">
          <p class="whitespace-pre-wrap">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
        </div>
      `;
    } else {
      const actionsHtml = (meta.actions || []).length > 0 ? `
        <div class="pt-2.5 flex flex-wrap gap-2 border-t border-slate-100 mt-2.5">
          ${meta.actions.map((a) => `
            <button onclick="App.handleCopilotAction('${a.tab || ''}', '${a.action || ''}', '${a.sku || ''}')"
              class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 transition flex items-center gap-1.5 shadow-2xs">
              <span>👉</span> ${a.label}
            </button>
          `).join('')}
        </div>
      ` : '';

      const sourcesHtml = (meta.sources || []).length > 0 ? `
        <div class="text-[10px] text-slate-400 mt-2 flex items-center gap-1 truncate">
          <span class="font-semibold text-slate-500">Verified Sources:</span> <span class="font-mono text-slate-500">${meta.sources.join(', ')}</span>
        </div>
      ` : '';

      div.innerHTML = `
        <div class="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center text-sm font-bold shrink-0 mt-0.5 shadow-xs">
          ✨
        </div>
        <div class="flex-1 max-w-[88%] bg-white border border-slate-200 rounded-2xl rounded-tl-sm p-4 md:p-5 shadow-xs text-xs text-slate-800 space-y-2">
          <div class="copilot-body leading-relaxed text-slate-800">${formatMarkdown(text)}</div>
          ${actionsHtml}
          <div class="flex items-center justify-between pt-2 border-t border-slate-100 text-[11px] text-slate-400">
            <span class="font-semibold text-slate-500">${meta.model || '⚡ Real-Time Ledger'}</span>
            <button type="button" onclick="App.copyToClipboard(this)" data-text="${text.replace(/"/g, '&quot;')}" class="hover:text-slate-700 font-medium transition">Copy</button>
          </div>
          ${sourcesHtml}
        </div>
      `;
    }

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  };

  const handleCopilotAction = (tab, action, sku) => {
    if (tab) {
      App.switchTab(tab);
      toggleCopilot(false);
    } else if (action === 'openAdjustForSku') {
      openAdjustForProduct(sku);
      toggleCopilot(false);
    } else if (action === 'openCycleCount') {
      openCycleCountModal();
      toggleCopilot(false);
    } else if (action === 'newPo') {
      openOrderModal('PURCHASE');
      toggleCopilot(false);
    } else if (action === 'openImport') {
      openImportModal();
      toggleCopilot(false);
    } else if (action === 'runPipeline') {
      runPipeline();
    }
  };

  const clearCopilotHistory = () => {
    copilotHistory = [];
    const container = $('copilotMessages');
    if (container) {
      container.innerHTML = `
        <div class="flex items-start gap-3">
          <div class="w-7 h-7 rounded-lg bg-indigo-600 text-white flex items-center justify-center text-xs font-bold shrink-0">
            ✨
          </div>
          <div class="flex-1 bg-white border border-slate-200 rounded-2xl rounded-tl-sm p-3.5 shadow-2xs space-y-2 text-xs text-slate-800">
            <p class="font-bold text-slate-900">Chat history cleared.</p>
            <p>Ask a new question about live stock, purchasing budget, or wholesale operations.</p>
          </div>
        </div>
      `;
    }
  };

  const copyToClipboard = (btn) => {
    const text = btn?.getAttribute('data-text');
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  };

  // ──────────────────────────────────────────
  // Easy Read Mode (Seniors & Beginners +15% scale)
  // ──────────────────────────────────────────
  const toggleEasyReadMode = () => {
    document.body.classList.toggle('easy-read');
    const isEasy = document.body.classList.contains('easy-read');
    localStorage.setItem('easy_read_mode', isEasy);
    showToast(`Easy Read Mode ${isEasy ? 'Enabled (+15% text size)' : 'Disabled'}`, 'info');
  };

  // ──────────────────────────────────────────
  // Reversible Actions (Unconfirm / Cancel / Void & Revert)
  // ──────────────────────────────────────────
  const unconfirmOrderAction = async (orderId, type) => {
    try {
      const res = await api(`/api/orders/${orderId}/unconfirm`, { method: 'POST' });
      if (res && res.success) {
        showToast(res.message || 'Order reverted to Draft status', 'success');
        if (type === 'PURCHASE') loadPurchaseOrders();
        else loadSalesOrders();
        loadOverviewData();
      }
    } catch (err) {
      showToast(err.message || 'Could not revert order', 'error');
    }
  };

  const cancelOrderAction = async (orderId, type) => {
    if (!confirm('Are you sure you want to cancel this order?')) return;
    try {
      const res = await api(`/api/orders/${orderId}/cancel`, { method: 'POST' });
      if (res && (res.success || res.status === 'CANCELLED')) {
        showToast('Order cancelled', 'info');
        if (type === 'PURCHASE') loadPurchaseOrders();
        else loadSalesOrders();
        loadOverviewData();
      }
    } catch (err) {
      try {
        await api(`/api/orders/${orderId}/unconfirm`, { method: 'POST' });
        showToast('Order reverted to Draft', 'info');
        if (type === 'PURCHASE') loadPurchaseOrders();
        else loadSalesOrders();
      } catch (e2) {
        showToast(err.message || 'Could not cancel order', 'error');
      }
    }
  };

  const voidAndRevertOrderAction = async (orderId, type) => {
    const reason = prompt('Please enter reason for voiding & reversing this order:', 'Order mistake / cancelled by user');
    if (!reason) return;
    try {
      const res = await api(`/api/orders/${orderId}/void-and-revert`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
      if (res && res.success) {
        showToast(res.message || 'Order voided and stock restored', 'success');
        if (type === 'PURCHASE') loadPurchaseOrders();
        else loadSalesOrders();
        loadOverviewData();
        loadPayments();
      }
    } catch (err) {
      showToast(err.message || 'Could not reverse order', 'error');
    }
  };

  const voidPaymentAction = async (paymentId) => {
    const reason = prompt('Reason for voiding payment allocation:', 'Allocation entry error');
    if (!reason) return;
    try {
      const res = await api(`/api/payments/${paymentId}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
      if (res && res.success) {
        showToast(res.message || 'Payment allocation voided', 'success');
        loadPayments();
        loadPurchaseOrders();
        loadSalesOrders();
        loadOverviewData();
      }
    } catch (err) {
      showToast(err.message || 'Could not void payment', 'error');
    }
  };

  // ──────────────────────────────────────────
  // Order Import via CSV or PDF
  // ──────────────────────────────────────────
  let orderImportData = {
    type: 'PURCHASE',
    items: [],
    allProducts: [],
    contacts: []
  };

  const openOrderImportModal = async (type) => {
    orderImportData.type = type || 'PURCHASE';
    orderImportData.items = [];
    const isPurchase = orderImportData.type === 'PURCHASE';

    if ($('orderImportModalTitle')) {
      $('orderImportModalTitle').textContent = isPurchase
        ? '📄 Import Purchase Order (PDF / CSV)'
        : '📄 Import Sales Order (PDF / CSV)';
    }
    if ($('orderImportContactLabel')) {
      $('orderImportContactLabel').textContent = isPurchase ? 'Supplier / Vendor *' : 'Customer *';
    }

    const fileInput = $('orderImportFileInput');
    if (fileInput) fileInput.value = '';

    const statusBox = $('orderImportStatus');
    if (statusBox) {
      statusBox.classList.add('hidden');
      statusBox.textContent = '';
    }
    const preview = $('orderImportPreviewContainer');
    if (preview) preview.classList.add('hidden');

    const btn = $('orderImportSubmitBtn');
    if (btn) btn.disabled = true;

    const d = new Date();
    d.setDate(d.getDate() + 7);
    if ($('orderImportDueDate')) $('orderImportDueDate').value = d.toISOString().split('T')[0];

    try {
      const contacts = await api(`/api/contacts?type=${isPurchase ? 'SUPPLIER' : 'CUSTOMER'}`);
      const select = $('orderImportContactSelect');
      if (select) {
        select.innerHTML = '<option value="">Select party…</option>' +
          (contacts || []).map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
      }
    } catch (e) {
      console.error('Error loading contacts for order import:', e);
    }

    openModal('orderImportModal');
  };

  const handleOrderImportFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const statusBox = $('orderImportStatus');
    if (statusBox) {
      statusBox.className = 'p-3 rounded-lg text-xs font-semibold bg-indigo-50 text-indigo-800 border border-indigo-200';
      statusBox.textContent = `Analyzing ${file.name}…`;
      statusBox.classList.remove('hidden');
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const isPdf = file.name.toLowerCase().endsWith('.pdf');
        let payload = {
          file_name: file.name,
          file_type: file.type || (isPdf ? 'application/pdf' : 'text/csv'),
          order_type: orderImportData.type
        };

        if (isPdf) {
          const base64 = e.target.result.split(',')[1];
          payload.document_base64 = base64;
        } else {
          payload.text_content = e.target.result;
        }

        const res = await api('/api/data/parse-order-document', {
          method: 'POST',
          body: JSON.stringify(payload)
        });

        if (!res || !res.items || res.items.length === 0) {
          if (statusBox) {
            statusBox.className = 'p-3 rounded-lg text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200';
            statusBox.textContent = 'No recognizable line items found in this document. Please verify the format or download our sample template.';
          }
          return;
        }

        orderImportData.items = res.items;
        orderImportData.allProducts = res.allProducts || [];
        orderImportData.contacts = res.contacts || [];

        if (res.contacts && res.contacts.length > 0 && $('orderImportContactSelect')) {
          const select = $('orderImportContactSelect');
          select.innerHTML = '<option value="">Select party…</option>' +
            res.contacts.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
        }

        if (statusBox) {
          const matchedCount = res.items.filter(i => i.matched).length;
          statusBox.className = 'p-3 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200';
          statusBox.textContent = `Successfully parsed ${res.items.length} line items (${matchedCount} auto-matched to catalog).`;
        }

        renderOrderImportPreview();
      } catch (parseErr) {
        if (statusBox) {
          statusBox.className = 'p-3 rounded-lg text-xs font-semibold bg-rose-50 text-rose-800 border border-rose-200';
          statusBox.textContent = `Error parsing file: ${parseErr.message}`;
        }
      }
    };

    if (file.name.toLowerCase().endsWith('.pdf')) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file);
    }
  };

  const renderOrderImportPreview = () => {
    const tbody = $('orderImportTableBody');
    if (!tbody) return;

    let totalCents = 0;
    tbody.innerHTML = orderImportData.items.map((item, idx) => {
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const priceDollars = parseFloat(item.unit_price_dollars) || 0;
      const lineTotalDollars = (qty * priceDollars).toFixed(2);
      totalCents += Math.round(qty * priceDollars * 100);

      const productOptions = orderImportData.allProducts.map((p) => {
        const isSelected = item.product_id === p.id;
        return `<option value="${p.id}" ${isSelected ? 'selected' : ''}>${p.sku} — ${p.name}</option>`;
      }).join('');

      const matchBadge = item.matched
        ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">MATCHED</span>`
        : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">MAP SKU</span>`;

      return `
        <tr class="hover:bg-slate-50">
          <td class="py-2 px-3">
            <div class="font-bold text-slate-800">${item.candidate_sku || item.sku || 'Line ' + (idx + 1)}</div>
            <div class="text-[10px] text-slate-500 truncate max-w-[160px]">${item.name || item.original_line || ''}</div>
          </td>
          <td class="py-2 px-3">
            <div class="flex items-center gap-1.5">
              ${matchBadge}
              <select onchange="App.handleImportProductSelect(${idx}, this.value)" class="text-xs border border-slate-300 rounded px-2 py-1 max-w-[200px] bg-white">
                <option value="">-- Choose Catalog SKU --</option>
                ${productOptions}
              </select>
            </div>
          </td>
          <td class="py-2 px-3 text-right">
            <input type="number" min="1" value="${qty}" onchange="App.handleImportQtyChange(${idx}, this.value)" class="w-16 text-right border border-slate-300 rounded px-1.5 py-1 text-xs" />
          </td>
          <td class="py-2 px-3 text-right">
            <input type="number" step="0.01" min="0" value="${priceDollars.toFixed(2)}" onchange="App.handleImportPriceChange(${idx}, this.value)" class="w-20 text-right border border-slate-300 rounded px-1.5 py-1 text-xs" />
          </td>
          <td class="py-2 px-3 text-right font-bold text-slate-900">$${lineTotalDollars}</td>
          <td class="py-2 px-3 text-center">
            <button onclick="App.removeImportLine(${idx})" class="text-rose-500 hover:text-rose-700 text-sm font-bold">&times;</button>
          </td>
        </tr>
      `;
    }).join('');

    if ($('orderImportItemCount')) $('orderImportItemCount').textContent = orderImportData.items.length;
    if ($('orderImportTotal')) $('orderImportTotal').textContent = formatMoney(totalCents);
    if ($('orderImportPreviewContainer')) $('orderImportPreviewContainer').classList.remove('hidden');

    const btn = $('orderImportSubmitBtn');
    if (btn) btn.disabled = orderImportData.items.length === 0;
  };

  const handleImportProductSelect = (idx, prodId) => {
    if (!orderImportData.items[idx]) return;
    const id = parseInt(prodId, 10);
    orderImportData.items[idx].product_id = id || null;
    orderImportData.items[idx].matched = !!id;
    if (id) {
      const p = orderImportData.allProducts.find(prod => prod.id === id);
      if (p && !orderImportData.items[idx].unit_price_dollars) {
        const cents = orderImportData.type === 'PURCHASE' ? p.cost_price_cents : p.sell_price_cents;
        orderImportData.items[idx].unit_price_dollars = (cents / 100).toFixed(2);
      }
    }
    renderOrderImportPreview();
  };

  const handleImportQtyChange = (idx, val) => {
    if (!orderImportData.items[idx]) return;
    orderImportData.items[idx].quantity = Math.max(1, parseInt(val, 10) || 1);
    renderOrderImportPreview();
  };

  const handleImportPriceChange = (idx, val) => {
    if (!orderImportData.items[idx]) return;
    orderImportData.items[idx].unit_price_dollars = Math.max(0, parseFloat(val) || 0);
    renderOrderImportPreview();
  };

  const removeImportLine = (idx) => {
    orderImportData.items.splice(idx, 1);
    renderOrderImportPreview();
  };

  const createOrderFromImport = async () => {
    const contactId = $('orderImportContactSelect')?.value;
    const dueDate = $('orderImportDueDate')?.value;

    if (!contactId) {
      alert('Please select a contact/party for this order');
      return;
    }
    if (!dueDate) {
      alert('Please select a due date');
      return;
    }

    const validLines = orderImportData.items.filter(i => i.product_id);
    if (validLines.length === 0) {
      alert('Please map at least one item to a catalog SKU before creating the order.');
      return;
    }

    const lines = validLines.map(i => ({
      product_id: i.product_id,
      quantity: parseInt(i.quantity, 10) || 1,
      unit_price_cents: Math.round((parseFloat(i.unit_price_dollars) || 0) * 100)
    }));

    try {
      const res = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          type: orderImportData.type,
          contact_id: parseInt(contactId, 10),
          due_date: dueDate,
          lines,
          notes: 'Imported via CSV/PDF'
        })
      });

      if (res && (res.id || res.order_number)) {
        showToast(`Draft Order ${res.order_number} created with ${lines.length} lines`, 'success');
        closeModal('orderImportModal');
        if (orderImportData.type === 'PURCHASE') loadPurchaseOrders();
        else loadSalesOrders();
      }
    } catch (err) {
      showToast(err.message || 'Error creating order from import', 'error');
    }
  };

  // ──────────────────────────────────────────
  // Copilot Resizing & Floating Pill
  // ──────────────────────────────────────────
  const initCopilotResizer = () => {
    const handle = $('copilotResizeHandle');
    const drawer = $('copilotDrawer');
    if (!handle || !drawer) return;

    let isResizing = false;

    handle.addEventListener('mousedown', (e) => {
      isResizing = true;
      handle.classList.add('active');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const newWidth = Math.max(300, Math.min(650, window.innerWidth - e.clientX));
      drawer.style.width = `${newWidth}px`;
    });

    window.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  };

  const minimizeCopilot = () => {
    const drawer = $('copilotDrawer');
    const pill = $('copilotMiniPill');
    const backdrop = $('copilotBackdrop');
    if (drawer) drawer.classList.add('translate-x-full');
    if (backdrop) backdrop.classList.add('hidden');
    if (pill) pill.classList.remove('hidden');
  };

  const restoreCopilot = () => {
    const pill = $('copilotMiniPill');
    if (pill) pill.classList.add('hidden');
    toggleCopilot(true);
  };

  const toggleCopilotWidthPreset = () => {
    const drawer = $('copilotDrawer');
    if (!drawer) return;
    const current = parseInt(drawer.style.width || '340', 10);
    if (current < 450) {
      drawer.style.width = '520px';
    } else {
      drawer.style.width = '340px';
    }
  };

  // ──────────────────────────────────────────
  // B2B Wholesale Network Controller
  // ──────────────────────────────────────────
  let b2bCart = {
    sellerId: null,
    sellerName: '',
    items: []
  };

  const switchB2bTab = (tab) => {
    ['wholesalers', 'matches', 'orders'].forEach((t) => {
      const btn = $(`b2bTab${t.charAt(0).toUpperCase() + t.slice(1)}Btn`);
      const view = $(`b2bTab${t.charAt(0).toUpperCase() + t.slice(1)}View`);
      if (t === tab) {
        if (btn) btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white shadow-2xs transition';
        if (view) view.classList.remove('hidden');
      } else {
        if (btn) btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 transition';
        if (view) view.classList.add('hidden');
      }
    });
  };

  const loadB2bData = async () => {
    try {
      const [dirs, matches, orders] = await Promise.all([
        api('/api/b2b/directory', { silent: true }).catch(() => []),
        api('/api/b2b/matches', { silent: true }).catch(() => []),
        api('/api/b2b/orders', { silent: true }).catch(() => ({ inbound: [], outbound: [] }))
      ]);

      renderB2bDirectory(dirs);
      renderB2bMatches(matches);
      renderB2bOrders(orders);
    } catch (err) {
      console.error('Error loading B2B data:', err);
    }
  };

  const renderB2bDirectory = (dirs) => {
    const container = $('b2bDirectoryList');
    if (!container) return;

    if (!dirs || dirs.length === 0) {
      container.innerHTML = '<div class="col-span-3 py-12 text-center text-slate-400 bg-white rounded-xl border border-slate-200">No other verified wholesale distributors active on the network.</div>';
      return;
    }

    container.innerHTML = dirs.map((d) => `
      <div class="bg-white rounded-xl border border-slate-200 p-5 shadow-xs flex flex-col justify-between hover:border-indigo-300 transition">
        <div>
          <div class="flex items-start justify-between gap-2 mb-2">
            <div class="flex items-center gap-2">
              <span class="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-700 font-bold flex items-center justify-center text-sm">🏢</span>
              <div>
                <h4 class="text-sm font-bold text-slate-900">${d.public_name}</h4>
                <p class="text-[11px] text-slate-500">${d.category || 'General Wholesale'} • ${d.city || 'Hub'}</p>
              </div>
            </div>
            ${d.is_verified ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">VERIFIED</span>' : ''}
          </div>
          <p class="text-xs text-slate-600 line-clamp-2 my-2">${d.description || 'Verified wholesale distributor with immediate fulfillment capability.'}</p>
          <div class="grid grid-cols-2 gap-2 text-[11px] text-slate-500 bg-slate-50 p-2.5 rounded-lg border border-slate-100 my-2">
            <div>Min Order: <strong class="text-slate-800">${formatMoney(d.min_order_cents || 0)}</strong></div>
            <div>Delivery: <strong class="text-slate-800">${d.delivery_days || 3} days</strong></div>
            <div>Active SKUs: <strong class="text-indigo-700">${d.active_skus || 0} items</strong></div>
          </div>
        </div>
        <div class="pt-3 border-t border-slate-100 mt-2">
          <button onclick="App.openB2bCatalogModal(${d.business_id}, '${d.public_name.replace(/'/g, "\\'")}')" class="w-full py-2 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-semibold text-xs transition">
            Browse Wholesale Catalog & Order ➔
          </button>
        </div>
      </div>
    `).join('');
  };

  const renderB2bMatches = (matches) => {
    const container = $('b2bMatchesList');
    if (!container) return;

    if (!matches || matches.length === 0) {
      container.innerHTML = '<div class="py-12 text-center text-slate-400 bg-white rounded-xl border border-slate-200">No urgent inventory shortages matching wholesale suppliers right now. Your inventory health is optimal!</div>';
      return;
    }

    container.innerHTML = matches.map((m) => `
      <div class="bg-white rounded-xl border border-slate-200 p-4 shadow-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 font-bold flex items-center justify-center text-base shrink-0">⚠️</div>
          <div>
            <div class="flex items-center gap-2">
              <span class="font-bold text-slate-900 text-xs">${m.sku}</span>
              <span class="text-xs text-slate-600">${m.product_name}</span>
              <span class="px-2 py-0.2 rounded text-[10px] font-bold bg-rose-50 text-rose-700">Stockout Risk</span>
            </div>
            <p class="text-[11px] text-slate-500 mt-0.5">Your Stock: <strong class="text-rose-600">${m.my_stock.on_hand}</strong> units (${m.my_stock.days_of_cover}d cover, lead ${m.my_stock.lead_days}d). Available from <strong class="text-indigo-700">${m.seller.seller_name}</strong> at ${formatMoney(m.seller.b2b_price_cents)}/unit.</p>
          </div>
        </div>
        <div class="shrink-0 flex items-center gap-2">
          <button onclick="App.openB2bCatalogModal(${m.seller.seller_id}, '${m.seller.seller_name.replace(/'/g, "\\'")}')" class="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs shadow-2xs transition">
            Order from ${m.seller.seller_name}
          </button>
        </div>
      </div>
    `).join('');
  };

  const renderB2bOrders = (orders) => {
    const inbound = orders?.inbound || [];
    const outbound = orders?.outbound || [];

    if ($('b2bInboundCountBadge')) $('b2bInboundCountBadge').textContent = `${inbound.length} Inbound`;
    if ($('b2bOutboundCountBadge')) $('b2bOutboundCountBadge').textContent = `${outbound.length} Outbound`;

    const inTbody = $('b2bInboundOrdersTableBody');
    if (inTbody) {
      if (inbound.length === 0) {
        inTbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-400">No inbound orders from other wholesalers yet.</td></tr>';
      } else {
        inTbody.innerHTML = inbound.map((o) => {
          let badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">${o.status}</span>`;
          if (o.status === 'ACCEPTED') badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">ACCEPTED (SO Active)</span>`;
          if (o.status === 'SHIPPED') badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">SHIPPED</span>`;
          if (o.status === 'COMPLETED') badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">COMPLETED</span>`;
          if (o.status === 'DECLINED' || o.status === 'CANCELLED') badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700">VOIDED</span>`;

          return `
            <tr class="hover:bg-slate-50">
              <td class="py-2.5 px-4 font-bold text-slate-900">${o.trade_reference}</td>
              <td class="py-2.5 px-4 font-semibold text-slate-800">${o.buyer_name}</td>
              <td class="py-2.5 px-4 text-slate-500">${formatDate(o.created_at)}</td>
              <td class="py-2.5 px-4 text-right font-bold text-slate-900">${formatMoney(o.total_cents)}</td>
              <td class="py-2.5 px-4 text-center">${badge}</td>
              <td class="py-2.5 px-4 text-right">
                <div class="inline-flex items-center gap-1.5 justify-end">
                  ${o.status === 'REQUESTED' ? `
                    <button onclick="App.acceptB2bTrade(${o.id})" class="px-2.5 py-1 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs transition">Accept</button>
                    <button onclick="App.declineB2bTrade(${o.id})" class="px-2 py-1 rounded text-xs font-semibold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition">Decline</button>
                  ` : ''}
                  ${o.status === 'ACCEPTED' ? `
                    <button onclick="App.shipB2bTrade(${o.id})" class="px-2.5 py-1 rounded text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-2xs transition">Mark Shipped</button>
                  ` : ''}
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    const outTbody = $('b2bOutboundOrdersTableBody');
    if (outTbody) {
      if (outbound.length === 0) {
        outTbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-400">No outbound replenishment orders placed yet.</td></tr>';
      } else {
        outTbody.innerHTML = outbound.map((o) => {
          let badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">${o.status}</span>`;
          if (o.status === 'ACCEPTED') badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">CONFIRMED (Awaiting Dispatch)</span>`;
          if (o.status === 'SHIPPED') badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">IN TRANSIT</span>`;
          if (o.status === 'COMPLETED') badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">RECEIVED</span>`;
          if (o.status === 'DECLINED' || o.status === 'CANCELLED') badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700">VOIDED</span>`;

          return `
            <tr class="hover:bg-slate-50">
              <td class="py-2.5 px-4 font-bold text-slate-900">${o.trade_reference}</td>
              <td class="py-2.5 px-4 font-semibold text-slate-800">${o.seller_name}</td>
              <td class="py-2.5 px-4 text-slate-500">${formatDate(o.created_at)}</td>
              <td class="py-2.5 px-4 text-right font-bold text-slate-900">${formatMoney(o.total_cents)}</td>
              <td class="py-2.5 px-4 text-center">${badge}</td>
              <td class="py-2.5 px-4 text-right">
                <div class="inline-flex items-center gap-1.5 justify-end">
                  ${['REQUESTED', 'ACCEPTED'].includes(o.status) ? `
                    <button onclick="App.declineB2bTrade(${o.id})" class="px-2 py-1 rounded text-xs font-semibold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition">Cancel</button>
                  ` : ''}
                  ${o.status === 'SHIPPED' ? `
                    <button onclick="App.receiveB2bTrade(${o.id})" class="px-2.5 py-1 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs transition">Receive Stock</button>
                  ` : ''}
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }
    }
  };

  const openB2bCatalogModal = async (sellerId, sellerName) => {
    b2bCart = {
      sellerId,
      sellerName,
      items: []
    };

    if ($('b2bCatalogModalTitle')) $('b2bCatalogModalTitle').textContent = `${sellerName} — Wholesale Catalog`;
    if ($('b2bTradeCartTotal')) $('b2bTradeCartTotal').textContent = '$0.00';

    const container = $('b2bCatalogListContainer');
    if (container) container.innerHTML = '<div class="py-12 text-center text-slate-400">Loading catalog…</div>';

    openModal('b2bCatalogModal');

    try {
      const catalog = await api(`/api/b2b/catalog?seller_id=${sellerId}`);
      if (!catalog || catalog.length === 0) {
        if (container) container.innerHTML = '<div class="py-12 text-center text-slate-400">This wholesaler has no items listed at the moment.</div>';
        return;
      }

      b2bCart.catalog = catalog;
      container.innerHTML = catalog.map((item) => `
        <div class="bg-slate-50 rounded-xl border border-slate-200 p-4 flex items-center justify-between gap-4">
          <div>
            <div class="flex items-center gap-2">
              <span class="font-bold text-slate-900 text-xs">${item.sku}</span>
              <span class="text-xs text-slate-700">${item.name}</span>
              <span class="px-2 py-0.5 rounded text-[10px] font-bold ${item.availability_status === 'In Stock' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">
                ${item.availability_status}
              </span>
            </div>
            <p class="text-[11px] text-slate-500 mt-1">Pack Size: ${item.pack_size} | MOQ: ${item.b2b_moq} units | Category: ${item.category || 'General'}</p>
            <p class="text-sm font-bold text-indigo-700 mt-0.5">${formatMoney(item.b2b_price_cents)} / unit</p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <label class="text-xs text-slate-500 font-semibold">Qty:</label>
            <input type="number" id="b2bQty-${item.product_id}" min="${item.b2b_moq || 1}" step="${item.pack_size || 1}" value="${item.b2b_moq || 1}" 
              onchange="App.updateB2bCartItem(${item.product_id}, this.value)" 
              class="w-20 border border-slate-300 rounded-lg px-2 py-1.5 text-xs text-right bg-white font-bold" />
          </div>
        </div>
      `).join('');

      b2bCart.items = catalog.map(c => ({
        product_id: c.product_id,
        quantity: c.b2b_moq || 1,
        unit_price_cents: c.b2b_price_cents
      }));
      updateB2bCartTotal();
    } catch (err) {
      if (container) container.innerHTML = `<div class="p-4 text-xs text-rose-600 bg-rose-50 rounded-xl">Error: ${err.message}</div>`;
    }
  };

  const updateB2bCartItem = (prodId, val) => {
    const qty = Math.max(0, parseInt(val, 10) || 0);
    const item = (b2bCart.items || []).find(i => i.product_id === prodId);
    if (item) item.quantity = qty;
    updateB2bCartTotal();
  };

  const updateB2bCartTotal = () => {
    let totalCents = 0;
    (b2bCart.items || []).forEach(i => {
      totalCents += (i.quantity || 0) * (i.unit_price_cents || 0);
    });
    if ($('b2bTradeCartTotal')) $('b2bTradeCartTotal').textContent = formatMoney(totalCents);
  };

  const submitB2bTradeOrder = async () => {
    const activeItems = (b2bCart.items || []).filter(i => i.quantity > 0);
    if (activeItems.length === 0) {
      alert('Please enter a quantity greater than zero for at least one item.');
      return;
    }

    try {
      const res = await api('/api/b2b/orders/request', {
        method: 'POST',
        body: JSON.stringify({
          seller_business_id: b2bCart.sellerId,
          items: activeItems,
          trade_notes: 'B2B replenishment order'
        })
      });

      if (res && res.success) {
        showToast(`B2B Order ${res.tradeReference} created and submitted to ${b2bCart.sellerName}`, 'success');
        closeModal('b2bCatalogModal');
        loadB2bData();
        loadPurchaseOrders();
      }
    } catch (err) {
      showToast(err.message || 'Could not place B2B trade order', 'error');
    }
  };

  const acceptB2bTrade = async (id) => {
    try {
      const res = await api(`/api/b2b/orders/${id}/accept`, { method: 'POST' });
      if (res && res.success) {
        showToast(res.message || 'Trade order accepted and Sales Order generated', 'success');
        loadB2bData();
        loadSalesOrders();
        loadInventory();
      }
    } catch (err) {
      showToast(err.message || 'Could not accept trade order', 'error');
    }
  };

  const declineB2bTrade = async (id) => {
    const reason = prompt('Reason for declining / cancelling this trade order:', 'Item currently unavailable / cancelled by operator');
    if (!reason) return;
    try {
      const res = await api(`/api/b2b/orders/${id}/decline`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
      if (res && res.success) {
        showToast(res.message || 'Trade order cancelled', 'info');
        loadB2bData();
        loadPurchaseOrders();
        loadSalesOrders();
      }
    } catch (err) {
      showToast(err.message || 'Could not cancel trade order', 'error');
    }
  };

  const shipB2bTrade = async (id) => {
    try {
      const res = await api(`/api/b2b/orders/${id}/ship`, { method: 'POST' });
      if (res && res.success) {
        showToast(res.message || 'Order marked as shipped', 'success');
        loadB2bData();
        loadSalesOrders();
      }
    } catch (err) {
      showToast(err.message || 'Could not ship trade order', 'error');
    }
  };

  const receiveB2bTrade = async (id) => {
    try {
      const res = await api(`/api/b2b/orders/${id}/receive`, { method: 'POST' });
      if (res && res.success) {
        showToast(res.message || 'Stock received into warehouse ledger', 'success');
        loadB2bData();
        loadPurchaseOrders();
        loadInventory();
        loadOverviewData();
      }
    } catch (err) {
      showToast(err.message || 'Could not receive trade order', 'error');
    }
  };

  const openB2bProfileModal = async () => {
    try {
      const prof = await api('/api/b2b/profile');
      if (prof) {
        if ($('b2bProfilePublicName')) $('b2bProfilePublicName').value = prof.public_name || '';
        if ($('b2bProfileCategory')) $('b2bProfileCategory').value = prof.category || '';
        if ($('b2bProfileCity')) $('b2bProfileCity').value = prof.city || '';
        if ($('b2bProfileMinOrder')) $('b2bProfileMinOrder').value = (prof.min_order_cents ? prof.min_order_cents / 100 : 250);
        if ($('b2bProfileLeadDays')) $('b2bProfileLeadDays').value = prof.delivery_days || 3;
        if ($('b2bProfileRegNo')) $('b2bProfileRegNo').value = prof.gst_or_reg_no || '';
        if ($('b2bProfileDescription')) $('b2bProfileDescription').value = prof.description || '';
        if ($('b2bProfileIsPublic')) $('b2bProfileIsPublic').checked = prof.is_public === 1;
      }
    } catch (err) {
      console.error('Error fetching B2B profile:', err);
    }
    openModal('b2bProfileModal');
  };

  const saveB2bProfile = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        public_name: $('b2bProfilePublicName')?.value,
        category: $('b2bProfileCategory')?.value,
        city: $('b2bProfileCity')?.value,
        min_order_cents: Math.round((parseFloat($('b2bProfileMinOrder')?.value) || 0) * 100),
        delivery_days: parseInt($('b2bProfileLeadDays')?.value, 10) || 3,
        gst_or_reg_no: $('b2bProfileRegNo')?.value,
        description: $('b2bProfileDescription')?.value,
        is_public: $('b2bProfileIsPublic')?.checked ? 1 : 0
      };

      const res = await api('/api/b2b/profile', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (res && res.success) {
        showToast('B2B wholesale profile updated', 'success');
        closeModal('b2bProfileModal');
        loadB2bData();
      }
    } catch (err) {
      showToast(err.message || 'Could not save profile', 'error');
    }
  };

  // ──────────────────────────────────────────
  // Bootstrap
  // ──────────────────────────────────────────
  const init = () => {
    try {
      if (localStorage.getItem('easy_read_mode') === 'true') {
        document.body.classList.add('easy-read');
      }
      initCopilotResizer();
      initNavigation();
      loadInitialData();

      // Global shortcut for AI Assistant (Ctrl+K or Alt+A)
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          toggleCopilot(true);
        } else if (e.altKey && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          toggleCopilot(true);
        }
      });
    } catch (err) {
      console.error('App init error:', err);
    }
  };

  // Publicly exposed methods
  return {
    init,
    logout,
    toggleCreateMenu,
    openDrawer,
    closeDrawer,
    openDrawerForProduct,
    generateDraftPo,
    generatePoFromDrawer,
    recomputeIntelligence,
    seedBenchmarkData,
    openOrderModal,
    addOrderLine,
    removeOrderLine,
    handleLineProductChange,
    handleLineQtyChange,
    handleLinePriceChange,
    submitOrder,
    openAdjustModal,
    openAdjustForProduct,
    toggleAdjustMode,
    handleAdjustProductChange,
    submitStockAdjust,
    openPaymentModal,
    openPaymentForOrder,
    handlePaymentOrderChange,
    submitPayment,
    openImportModal,
    toggleImportTab,
    handleImportDrop,
    handleImportFileSelect,
    clearImportFile,
    submitImport,
    openNewProductModal,
    submitNewProduct,
    openEditProductModal,
    submitEditProduct,
    deleteProduct,
    openContactsModal,
    filterContactsTab,
    openNewContactForm,
    openEditContactForm,
    submitContactForm,
    deleteContact,
    openCapitalModal,
    submitCapital,
    handleTodayAction,
    confirmOrderAction,
    openReceivePoModal,
    submitReceivePo,
    openFulfillSoModal,
    submitFulfillSo,
    archiveProductAction,
    unarchiveProductAction,
    openCycleCountModal,
    toggleCycleCountView,
    openCycleCountDetail,
    recordCountItem,
    recordCountReason,
    approveCycleCount,
    submitNewCycleCount,
    loadSettings,
    saveBusinessSettings,
    openAddTeamModal,
    submitAddTeam,
    toggleSidebar,
    exportCsv,
    filterCatalog,
    unarchiveProduct,
    openProfileModal,
    saveProfile,
    toggleUserStatus,
    toggleOnboardingBanner,
    updateOnboardingProgress,
    switchTab: (t) => {
      const btn = document.querySelector(`#sidebarNav [data-tab="${t}"]`);
      if (btn) btn.click();
    },
    closeModal,
    closeBdClick,
    toggleCopilot,
    minimizeCopilot,
    restoreCopilot,
    toggleCopilotWidthPreset,
    setCopilotMode,
    askCopilotPrompt,
    handleCopilotSubmit,
    handleCopilotAction,
    clearCopilotHistory,
    copyToClipboard,
    toggleEasyReadMode,
    unconfirmOrderAction,
    cancelOrderAction,
    voidAndRevertOrderAction,
    voidPaymentAction,
    openOrderImportModal,
    handleOrderImportFile,
    renderOrderImportPreview,
    handleImportProductSelect,
    handleImportQtyChange,
    handleImportPriceChange,
    removeImportLine,
    createOrderFromImport,
    switchB2bTab,
    loadB2bData,
    openB2bCatalogModal,
    updateB2bCartItem,
    submitB2bTradeOrder,
    acceptB2bTrade,
    declineB2bTrade,
    shipB2bTrade,
    receiveB2bTrade,
    openB2bProfileModal,
    saveB2bProfile
  };
})();

document.addEventListener('DOMContentLoaded', () => {
  try {
    App.init();
  } catch (err) {
    console.error('App DOMContentLoaded error:', err);
  }
});
