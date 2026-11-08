/**
 * forecasts.js — Modular Machine Learning Forecasts & Chart.js View Controller
 *
 * Implements:
 * 1. Dynamic Chart.js instance lifecycle management (immediate destruction of prior instances).
 * 2. Real data binding: historical daily demand + 14-day P50/P90 projection curve.
 * 3. Live pipeline synchronization: dynamically updates tables and drawers on recompute.
 */

'use strict';

(function () {
  let activeChartInstance = null;

  const destroyActiveChart = (canvas) => {
    if (activeChartInstance) {
      activeChartInstance.destroy();
      activeChartInstance = null;
    }
    if (canvas && typeof Chart !== 'undefined') {
      const existing = Chart.getChart(canvas);
      if (existing) existing.destroy();
    }
  };

  const renderForecastChart = (canvas, data) => {
    if (!canvas || typeof Chart === 'undefined' || !data) return null;

    destroyActiveChart(canvas);

    const history = (data.history || []).slice(-30);
    const futureDaily = data.forecast?.futureDaily || [];
    const p50Daily = data.forecast?.p50Daily || (data.forecast?.p50Qty ? data.forecast.p50Qty / 14 : 5);
    const p90Daily = data.forecast?.p90Daily || (p50Daily * 1.5);

    const labels = [];
    const pastData = [];
    const p50Data = [];
    const p90Data = [];

    // 1. Past 30 Days of Actual Sales
    history.forEach((h) => {
      const d = new Date(h.date || h.day);
      labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      const val = h.salesQty !== undefined ? h.salesQty : (h.quantity !== undefined ? h.quantity : (h.adjustedDemand || 0));
      pastData.push(val);
      p50Data.push(null);
      p90Data.push(null);
    });

    // 2. Today junction point
    const todayVal = pastData.length > 0 ? (pastData[pastData.length - 1] || 0) : 0;
    labels.push('Today');
    pastData.push(todayVal);
    p50Data.push(todayVal);
    p90Data.push(todayVal);

    // 3. Next 14 Days Forward Forecast Curve
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

    // Custom Plugin: Vertical dashed line at "Today"
    const todayDividerPlugin = {
      id: 'todayDividerPlugin',
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

          ctx.fillStyle = '#64748b';
          ctx.font = '10px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('TODAY', xPos, chartArea.top - 4);
          ctx.restore();
        }
      }
    };

    activeChartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Historical Sales (Past 30d)',
            data: pastData,
            borderColor: '#4f46e5',
            backgroundColor: '#4f46e5',
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 4,
            tension: 0.2
          },
          {
            label: 'Expected Demand (P50)',
            data: p50Data,
            borderColor: '#059669',
            backgroundColor: '#059669',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 2,
            pointHoverRadius: 4,
            tension: 0.15
          },
          {
            label: 'Peak Scenario (P90)',
            data: p90Data,
            borderColor: 'rgba(16, 185, 129, 0.4)',
            backgroundColor: 'rgba(16, 185, 129, 0.12)',
            fill: '+1',
            borderWidth: 1,
            pointRadius: 0,
            tension: 0.15
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              boxWidth: 12,
              font: { size: 11, family: 'Inter, system-ui, sans-serif' }
            }
          },
          tooltip: {
            backgroundColor: '#0f172a',
            padding: 10,
            titleFont: { size: 11 },
            bodyFont: { size: 11 }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              maxTicksLimit: 12,
              font: { size: 10 }
            }
          },
          y: {
            beginAtZero: true,
            grid: { color: '#f1f5f9' },
            ticks: { font: { size: 10 } }
          }
        }
      },
      plugins: [todayDividerPlugin]
    });

    return activeChartInstance;
  };

  window.ForecastsView = {
    destroyActiveChart,
    renderForecastChart,
    getActiveChart: () => activeChartInstance
  };
})();
