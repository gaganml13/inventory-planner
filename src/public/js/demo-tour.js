/**
 * demo-tour.js — 6-Step Interactive Spotlight Tour for Demo Guest Mode
 */
'use strict';

window.DemoTour = (() => {
  const STEPS = [
    {
      tab: 'overview',
      selector: '#overviewKpiStrip',
      title: '1. Overview & Cash Safety',
      body: 'Welcome! Your dashboard tells you one critical number first: your <strong>Safe-to-Spend Purchasing Budget</strong>—how much cash you can spend on stock today after setting aside your safety reserve and upcoming bills.',
      nextLabel: 'Next: Check Stock →'
    },
    {
      tab: 'inventory',
      selector: '#inventoryTableCard',
      title: '2. Catalog & Inventory Ledger',
      body: 'Here is your warehouse ledger. Notice how <strong>On-Hand</strong> (physical boxes) is separated from <strong>Available</strong> (boxes not yet promised to customers) and <strong>Incoming</strong> (on the way from suppliers).',
      nextLabel: 'Next: AI Demand Forecast →'
    },
    {
      tab: 'insights',
      selector: '#view-insights',
      title: '3. Demand Planning & ML Forecasts',
      body: 'Instead of guessing what to buy, our Python ML engine analyzes past sales to predict <strong>Expected Demand (P50)</strong> and <strong>Busy-Week Peak Demand (P90)</strong> for the next 14 days. Click <strong>Run Pipeline</strong> anytime to refresh.',
      nextLabel: 'Next: Buying & Selling →'
    },
    {
      tab: 'purchases',
      selector: '#view-purchases',
      title: '4. Purchasing & Reversible Drafts',
      body: 'Orders start as a safe <strong>Draft (Shopping Cart)</strong>—no money is deducted yet. Click <strong>Confirm</strong> when sent to your supplier, and <strong>Receive</strong> when the truck arrives! Mistake? Click <strong>Revert to Draft</strong> anytime.',
      nextLabel: 'Next: B2B Trade Network →'
    },
    {
      tab: 'b2b',
      selector: '#view-b2b',
      title: '5. 🌐 B2B Wholesale Trade Network',
      body: 'Need stock fast without middlemen? Browse verified wholesalers, or open <strong>My B2B Seller Profile</strong> to publish your own slow-moving stock so other businesses can order directly from you.',
      nextLabel: 'Next: Ask Your AI Copilot →'
    },
    {
      tab: null,
      selector: '#copilotTriggerBtn',
      title: '6. AI Copilot & Sandbox Freedom',
      body: 'Have a question anytime? Ask the <strong>AI Copilot</strong> in plain English! Feel free to click around and test anything—this is your safe Demo Sandbox (you can reset it anytime from the top bar).',
      nextLabel: '🎉 Finish & Explore Freely'
    }
  ];

  let currentStep = 0;
  let isActive = false;

  const ensureDom = () => {
    if (document.getElementById('demoTourOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'demoTourOverlay';
    overlay.className = 'fixed inset-0 z-[70] hidden pointer-events-none';
    overlay.innerHTML = `
      <div id="demoTourSpotlight" class="fixed rounded-xl ring-4 ring-indigo-500 shadow-[0_0_0_9999px_rgba(15,23,42,0.55)] transition-all duration-300 pointer-events-none"></div>
      <div id="demoTourPopover" class="fixed z-[75] w-[92vw] max-w-sm bg-white rounded-2xl shadow-2xl border border-indigo-200 p-5 pointer-events-auto transition-all duration-300">
        <div class="flex items-center justify-between mb-2">
          <span id="demoTourStepBadge" class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">Step 1 of 6</span>
          <button type="button" id="demoTourSkipBtn" class="text-xs font-semibold text-slate-400 hover:text-slate-700">Skip Tour</button>
        </div>
        <h4 id="demoTourTitle" class="text-sm font-bold text-slate-900 mb-1.5"></h4>
        <p id="demoTourBody" class="text-xs text-slate-600 leading-relaxed mb-4"></p>
        <div class="flex items-center justify-between gap-2 pt-3 border-t border-slate-100">
          <button type="button" id="demoTourBackBtn" class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition">← Back</button>
          <button type="button" id="demoTourNextBtn" class="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-xs transition"></button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('demoTourSkipBtn').addEventListener('click', () => stop(true));
    document.getElementById('demoTourBackBtn').addEventListener('click', prev);
    document.getElementById('demoTourNextBtn').addEventListener('click', next);
    window.addEventListener('resize', () => { if (isActive) positionStep(); });
  };

  const positionStep = () => {
    const step = STEPS[currentStep];
    const spotlight = document.getElementById('demoTourSpotlight');
    const popover = document.getElementById('demoTourPopover');
    if (!step || !spotlight || !popover) return;

    const target = document.querySelector(step.selector);
    if (!target || target.offsetParent === null) {
      // Fallback centered position if element not visible
      spotlight.style.width = '0px';
      spotlight.style.height = '0px';
      spotlight.style.top = '50%';
      spotlight.style.left = '50%';
      popover.style.top = '50%';
      popover.style.left = '50%';
      popover.style.transform = 'translate(-50%, -50%)';
      return;
    }

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });

    setTimeout(() => {
      if (!isActive) return;
      const rect = target.getBoundingClientRect();
      const pad = 6;
      const top = Math.max(8, rect.top - pad);
      const left = Math.max(8, rect.left - pad);
      const width = Math.min(window.innerWidth - 16, rect.width + pad * 2);
      const height = Math.min(window.innerHeight - 16, rect.height + pad * 2);

      spotlight.style.top = `${top}px`;
      spotlight.style.left = `${left}px`;
      spotlight.style.width = `${width}px`;
      spotlight.style.height = `${height}px`;

      popover.style.transform = 'none';
      const popH = popover.offsetHeight || 220;
      const popW = popover.offsetWidth || 360;

      let popTop = rect.bottom + 14;
      if (popTop + popH > window.innerHeight - 12) {
        popTop = Math.max(12, rect.top - popH - 14);
      }
      let popLeft = Math.max(12, Math.min(window.innerWidth - popW - 12, rect.left));
      popover.style.top = `${popTop}px`;
      popover.style.left = `${popLeft}px`;
    }, 180);
  };

  const renderStep = () => {
    const step = STEPS[currentStep];
    if (!step) return;

    if (step.tab && window.App && typeof window.App.switchTab === 'function') {
      window.App.switchTab(step.tab);
    }

    document.getElementById('demoTourStepBadge').textContent = `Step ${currentStep + 1} of ${STEPS.length}`;
    document.getElementById('demoTourTitle').textContent = step.title;
    document.getElementById('demoTourBody').innerHTML = step.body;
    document.getElementById('demoTourNextBtn').textContent = step.nextLabel;

    const backBtn = document.getElementById('demoTourBackBtn');
    backBtn.style.visibility = currentStep === 0 ? 'hidden' : 'visible';

    positionStep();
  };

  const start = (stepIdx = 0) => {
    ensureDom();
    currentStep = Math.max(0, Math.min(STEPS.length - 1, stepIdx));
    isActive = true;
    document.getElementById('demoTourOverlay').classList.remove('hidden');
    renderStep();
  };

  const next = () => {
    if (currentStep >= STEPS.length - 1) {
      stop(true);
      return;
    }
    currentStep += 1;
    renderStep();
  };

  const prev = () => {
    if (currentStep > 0) {
      currentStep -= 1;
      renderStep();
    }
  };

  const stop = (markCompleted = true) => {
    isActive = false;
    const overlay = document.getElementById('demoTourOverlay');
    if (overlay) overlay.classList.add('hidden');
    if (markCompleted) {
      localStorage.setItem('demo_tour_completed', 'true');
    }
  };

  return { start, next, prev, stop };
})();
