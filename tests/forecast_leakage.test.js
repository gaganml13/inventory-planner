/**
 * forecast_leakage.test.js
 *
 * Asserts historical backtesting partitions strictly precede test observation timestamps
 * (proving zero future-data leakage) and validates guardrails for insufficient data.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Forecaster = require('../src/modules/intelligence/forecaster');

test('Forecast Engine: Asserts zero future-data leakage in rolling-origin backtesting', () => {
  const forecaster = new Forecaster();

  // Create a 45-day continuous series
  const series = [];
  const baseDate = new Date('2026-08-01T00:00:00.000Z');
  const dayMs = 24 * 60 * 60 * 1000;

  for (let i = 0; i < 45; i++) {
    const d = new Date(baseDate.getTime() + i * dayMs);
    series.push({
      date: d.toISOString().split('T')[0],
      dayOfWeek: d.getUTCDay(),
      salesQty: 5 + Math.sin(i) * 3,
      adjustedDemand: 5 + Math.sin(i) * 3
    });
  }

  // Run backtesting with 7-day test horizon
  const backtest = forecaster.backtestModel(series, 7);

  assert.equal(backtest.status, 'VALIDATED');
  assert.ok(backtest.trainingCutoff, 'Training cutoff date must be present');
  assert.ok(backtest.testWindowStart, 'Test window start date must be present');

  // ASSERTION: Training cutoff strictly precedes test observation window
  const trainTime = new Date(backtest.trainingCutoff).getTime();
  const testTime = new Date(backtest.testWindowStart).getTime();

  assert.ok(
    trainTime < testTime,
    `Leakage Guard Assertion: train cutoff (${backtest.trainingCutoff}) must strictly precede test window start (${backtest.testWindowStart})`
  );

  // Time difference must be exactly 1 day (next consecutive observation)
  const diffDays = Math.round((testTime - trainTime) / dayMs);
  assert.equal(diffDays, 1, 'Test window must start immediately on the next day following train cutoff');

  // Verify feature extraction at index t strictly uses prior lags
  const tIndex = 25;
  const feat = forecaster.extractFeatures(series, tIndex);
  // feat: [1.0, lag1, lag7, lag14, rollingMean7, sinDow, cosDow]
  assert.equal(feat[1], series[tIndex - 1].adjustedDemand, 'lag_1 must be from t - 1');
  assert.equal(feat[2], series[tIndex - 7].adjustedDemand, 'lag_7 must be from t - 7');
  assert.equal(feat[3], series[tIndex - 14].adjustedDemand, 'lag_14 must be from t - 14');
});

test('Forecast Engine: Flags INSUFFICIENT_DATA and falls back to baseline min/max if < 14 sales events', () => {
  const forecaster = new Forecaster();

  // Series with only 5 sparse sales events across 30 days
  const sparseSeries = [];
  const baseDate = new Date('2026-08-01T00:00:00.000Z');
  const dayMs = 24 * 60 * 60 * 1000;

  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate.getTime() + i * dayMs);
    const qty = (i === 5 || i === 12 || i === 18 || i === 22 || i === 27) ? 4 : 0;
    sparseSeries.push({
      date: d.toISOString().split('T')[0],
      dayOfWeek: d.getUTCDay(),
      salesQty: qty,
      adjustedDemand: qty
    });
  }

  const forecast = forecaster.generateForecast(sparseSeries, 7);

  assert.equal(forecast.status, 'INSUFFICIENT_DATA', 'Must flag INSUFFICIENT_DATA when sales events < 14');
  assert.equal(forecast.modelName, 'BASELINE_MINMAX', 'Must fall back to BASELINE_MINMAX model');
  assert.equal(forecast.uncertaintyLevel, 'HIGH', 'Sparse data must have HIGH uncertainty');
  assert.ok(forecast.p50Qty > 0, 'Must still produce non-zero baseline p50 expectation');
});
