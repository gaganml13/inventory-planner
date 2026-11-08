/**
 * forecaster.js — Demand Forecasting Engine with Baselines, ML & Zero-Leakage Backtesting
 *
 * Implements:
 * - Baselines: 7-day Moving Average, 28-day Moving Average, Seasonal-Naive (t - 7).
 * - ML Model: Autoregressive Linear Model with features:
 *     lag_1, lag_7, lag_14, 7-day rolling mean, day-of-week cyclical encoding.
 * - Guardrail: If < 14 historical sales events, flags `INSUFFICIENT_DATA` and falls back to baseline min/max.
 * - Rolling-origin backtesting with strict timestamp boundaries (asserts no future-data leakage).
 * - Residual-based uncertainty scoring (p50, p90 predictions).
 */

'use strict';

class Forecaster {
  constructor() {}

  /**
   * Linear Algebra Helper: Solves regularized Ridge Regression (X^T * X + lambda * I)^(-1) * X^T * Y
   */
  fitRidgeRegression(X, Y, lambda = 0.1) {
    const numRows = X.length;
    const numCols = X[0].length;

    // Compute X^T * X (numCols x numCols)
    const XtX = Array.from({ length: numCols }, () => new Float64Array(numCols));
    for (let i = 0; i < numRows; i++) {
      const row = X[i];
      for (let j = 0; j < numCols; j++) {
        for (let k = j; k < numCols; k++) {
          const val = row[j] * row[k];
          XtX[j][k] += val;
          if (j !== k) XtX[k][j] += val;
        }
      }
    }

    // Add L2 ridge regularization to diagonal (skip bias term at index 0)
    for (let j = 1; j < numCols; j++) {
      XtX[j][j] += lambda;
    }

    // Compute X^T * Y (numCols x 1)
    const XtY = new Float64Array(numCols);
    for (let i = 0; i < numRows; i++) {
      const yVal = Y[i];
      const row = X[i];
      for (let j = 0; j < numCols; j++) {
        XtY[j] += row[j] * yVal;
      }
    }

    // Solve via Gaussian Elimination with partial pivoting
    const A = XtX.map((r) => Array.from(r));
    const B = Array.from(XtY);

    for (let i = 0; i < numCols; i++) {
      // Find pivot
      let maxRow = i;
      for (let k = i + 1; k < numCols; k++) {
        if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) {
          maxRow = k;
        }
      }

      // Swap rows
      const tmpA = A[i];
      A[i] = A[maxRow];
      A[maxRow] = tmpA;
      const tmpB = B[i];
      B[i] = B[maxRow];
      B[maxRow] = tmpB;

      // Pivot
      const pivot = A[i][i];
      if (Math.abs(pivot) < 1e-9) continue;

      for (let k = i + 1; k < numCols; k++) {
        const factor = A[k][i] / pivot;
        B[k] -= factor * B[i];
        for (let j = i; j < numCols; j++) {
          A[k][j] -= factor * A[i][j];
        }
      }
    }

    // Back substitution
    const beta = new Float64Array(numCols);
    for (let i = numCols - 1; i >= 0; i--) {
      let sum = B[i];
      for (let j = i + 1; j < numCols; j++) {
        sum -= A[i][j] * beta[j];
      }
      beta[i] = Math.abs(A[i][i]) > 1e-9 ? sum / A[i][i] : 0;
    }

    return beta;
  }

  /**
   * Extracts feature vector for time t using ONLY information prior to t.
   * Features: [1 (bias), lag_1, lag_7, lag_14, rolling_mean_7, sin(dow), cos(dow)]
   */
  extractFeatures(series, tIndex) {
    if (tIndex < 14) return null;

    const lag1 = series[tIndex - 1].adjustedDemand;
    const lag7 = series[tIndex - 7].adjustedDemand;
    const lag14 = series[tIndex - 14].adjustedDemand;

    // 7-day rolling mean prior to tIndex
    const prior7 = series.slice(tIndex - 7, tIndex).map((s) => s.adjustedDemand);
    const rollingMean7 = prior7.reduce((a, b) => a + b, 0) / 7;

    // Day of week cyclical encoding
    const dow = series[tIndex].dayOfWeek;
    const sinDow = Math.sin((2 * Math.PI * dow) / 7);
    const cosDow = Math.cos((2 * Math.PI * dow) / 7);

    return [1.0, lag1, lag7, lag14, rollingMean7, sinDow, cosDow];
  }

  /**
   * Evaluates demand categorization using Syntetos-Boylan classification rules:
   * ADI (Average Demand Interval): Average time between non-zero demand events
   * CV² (Coefficient of Variation Squared): (std_dev / mean)² of non-zero demand
   *
   * Classes:
   * - SMOOTH:       ADI < 1.32 and CV² < 0.49
   * - ERRATIC:      ADI < 1.32 and CV² >= 0.49
   * - INTERMITTENT: ADI >= 1.32 and CV² < 0.49
   * - LUMPY:        ADI >= 1.32 and CV² >= 0.49
   */
  classifyDemandPattern(series) {
    if (!series || series.length === 0) {
      return { pattern: 'UNKNOWN', adi: 999, cv2: 0, nonZeroEvents: 0 };
    }

    const nonZeroSales = series.filter((s) => s.salesQty > 0).map((s) => s.salesQty);
    const nonZeroCount = nonZeroSales.length;

    if (nonZeroCount === 0) {
      return { pattern: 'INACTIVE', adi: 999, cv2: 0, nonZeroEvents: 0 };
    }

    const adi = parseFloat((series.length / nonZeroCount).toFixed(2));

    const mean = nonZeroSales.reduce((a, b) => a + b, 0) / nonZeroCount;
    const variance = nonZeroCount > 1
      ? nonZeroSales.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (nonZeroCount - 1)
      : 0;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    const cv2 = parseFloat(Math.pow(cv, 2).toFixed(3));

    let pattern = 'SMOOTH';
    if (adi >= 1.32 && cv2 >= 0.49) pattern = 'LUMPY';
    else if (adi >= 1.32 && cv2 < 0.49) pattern = 'INTERMITTENT';
    else if (adi < 1.32 && cv2 >= 0.49) pattern = 'ERRATIC';

    return { pattern, adi, cv2, nonZeroEvents: nonZeroCount, meanNonZeroDemand: parseFloat(mean.toFixed(2)) };
  }

  /**
   * Croston's Method with Syntetos-Boylan Approximation (SBA)
   * Specifically handles intermittent and lumpy demand profiles without upward bias.
   */
  forecastCrostonSBA(series, horizonDays = 14, alpha = 0.1) {
    let z = 0; // estimated demand level
    let p = 1; // estimated inter-arrival time
    let q = 0; // periods since last non-zero demand
    let firstEventFound = false;

    for (let t = 0; t < series.length; t++) {
      const demand = series[t].salesQty || 0;
      q++;

      if (demand > 0) {
        if (!firstEventFound) {
          z = demand;
          p = q;
          firstEventFound = true;
        } else {
          z = z + alpha * (demand - z);
          p = p + alpha * (q - p);
        }
        q = 0;
      }
    }

    // Syntetos-Boylan bias correction factor: (1 - alpha / 2)
    const sbaFactor = (1 - alpha / 2);
    const rawRate = p > 0 ? (z / p) : 0.1;
    const dailyDemandRate = Math.max(0.05, parseFloat((rawRate * sbaFactor).toFixed(3)));

    const p50Total = dailyDemandRate * horizonDays;
    // For intermittent demand, variance incorporates compound Poisson process
    const variancePerDay = dailyDemandRate * (1 + 0.5 * dailyDemandRate);
    const horizonStd = Math.sqrt(horizonDays * variancePerDay);
    const p90Total = p50Total + (1.28 * horizonStd);

    const futureDaily = [];
    const lastDate = series.length > 0 ? new Date(series[series.length - 1].date) : new Date();
    const dayMs = 24 * 60 * 60 * 1000;

    for (let h = 1; h <= horizonDays; h++) {
      const nextDate = new Date(lastDate.getTime() + h * dayMs);
      const dayP90 = dailyDemandRate + (1.28 * Math.sqrt(variancePerDay));
      futureDaily.push({
        dayOffset: h,
        date: nextDate.toISOString().split('T')[0],
        p50: parseFloat(dailyDemandRate.toFixed(2)),
        p90: parseFloat(dayP90.toFixed(2))
      });
    }

    return {
      dailyMean: dailyDemandRate,
      p50Qty: parseFloat(p50Total.toFixed(2)),
      p90Qty: parseFloat(p90Total.toFixed(2)),
      futureDaily
    };
  }

  /**
   * Generates baseline forecasts:
   * - ma7: 7-day Moving Average
   * - ma28: 28-day Moving Average
   * - seasonalNaive: value from t - 7
   */
  computeBaselines(series) {
    const n = series.length;
    if (n === 0) return { ma7: 0, ma28: 0, seasonalNaive: 0 };

    const last7 = series.slice(Math.max(0, n - 7)).map((s) => s.adjustedDemand);
    const ma7 = last7.reduce((a, b) => a + b, 0) / Math.max(1, last7.length);

    const last28 = series.slice(Math.max(0, n - 28)).map((s) => s.adjustedDemand);
    const ma28 = last28.reduce((a, b) => a + b, 0) / Math.max(1, last28.length);

    const seasonalNaive = n >= 7 ? series[n - 7].adjustedDemand : ma7;

    return {
      ma7: parseFloat(ma7.toFixed(2)),
      ma28: parseFloat(ma28.toFixed(2)),
      seasonalNaive: parseFloat(seasonalNaive.toFixed(2))
    };
  }

  /**
   * Rolling-origin backtest without future-data leakage.
   * Asserts training cutoff strictly precedes test window.
   */
  backtestModel(series, testHorizon = 7) {
    const totalPoints = series.length;
    if (totalPoints < 28) {
      return {
        mape: 0.5,
        rmse: 2.0,
        uncertaintyScore: 0.7,
        uncertaintyLevel: 'HIGH',
        trainingCutoff: null,
        testWindowStart: null,
        status: 'INSUFFICIENT_DATA'
      };
    }

    const cutoffIndex = totalPoints - testHorizon;
    const trainingCutoffDate = series[cutoffIndex - 1].date;
    const testWindowStartDate = series[cutoffIndex].date;

    // STRICT ANTI-LEAKAGE ASSERTION:
    if (new Date(trainingCutoffDate).getTime() >= new Date(testWindowStartDate).getTime()) {
      throw new Error(`Data leakage violation: training cutoff (${trainingCutoffDate}) must strictly precede test window (${testWindowStartDate})`);
    }

    // Prepare training dataset up to cutoffIndex
    const Xtrain = [];
    const Ytrain = [];

    for (let t = 14; t < cutoffIndex; t++) {
      const feat = this.extractFeatures(series, t);
      if (feat) {
        Xtrain.push(feat);
        Ytrain.push(series[t].adjustedDemand);
      }
    }

    if (Xtrain.length < 10) {
      return {
        mape: 0.45,
        rmse: 1.5,
        uncertaintyScore: 0.65,
        uncertaintyLevel: 'HIGH',
        trainingCutoff: trainingCutoffDate,
        testWindowStart: testWindowStartDate,
        status: 'INSUFFICIENT_DATA'
      };
    }

    const beta = this.fitRidgeRegression(Xtrain, Ytrain);

    // Evaluate over test window
    let sumAbsPctErr = 0;
    let sumSquaredErr = 0;
    let evalCount = 0;

    for (let t = cutoffIndex; t < totalPoints; t++) {
      const feat = this.extractFeatures(series, t);
      if (!feat) continue;

      let pred = 0;
      for (let j = 0; j < feat.length; j++) pred += feat[j] * beta[j];
      pred = Math.max(0, pred);

      const actual = series[t].adjustedDemand;
      const absErr = Math.abs(actual - pred);
      sumSquaredErr += absErr * absErr;
      sumAbsPctErr += absErr / Math.max(1, actual);
      evalCount++;
    }

    const mape = evalCount > 0 ? sumAbsPctErr / evalCount : 0.35;
    const rmse = evalCount > 0 ? Math.sqrt(sumSquaredErr / evalCount) : 1.0;

    // Uncertainty score scaled 0.0 - 1.0 based on MAPE
    const uncertaintyScore = Math.min(1.0, Math.max(0.05, parseFloat(mape.toFixed(2))));
    let uncertaintyLevel = 'LOW';
    if (uncertaintyScore > 0.50) uncertaintyLevel = 'HIGH';
    else if (uncertaintyScore > 0.25) uncertaintyLevel = 'MEDIUM';

    return {
      mape: parseFloat(mape.toFixed(3)),
      rmse: parseFloat(rmse.toFixed(3)),
      uncertaintyScore,
      uncertaintyLevel,
      trainingCutoff: trainingCutoffDate,
      testWindowStart: testWindowStartDate,
      status: 'VALIDATED'
    };
  }

  /**
   * Main forecast driver:
   * Predicts daily demand over specified horizon (e.g., 7 to 14 days)
   * Returns p50, p90, model name, and uncertainty metrics.
   */
  generateForecast(series, horizonDays = 7) {
    const baselines = this.computeBaselines(series);
    const classification = this.classifyDemandPattern(series);

    // Count non-zero sales events
    const salesEvents = series.filter((s) => s.salesQty > 0).length;

    // Guardrail: if < 14 historical sales events, flag as INSUFFICIENT_DATA
    if (salesEvents < 14 || series.length < 21) {
      const dailyMean = baselines.ma7 > 0 ? baselines.ma7 : (baselines.ma28 > 0 ? baselines.ma28 : 1.0);
      const p50Total = dailyMean * horizonDays;
      const p90Total = p50Total * 1.5;

      const futureDaily = [];
      const lastDate = series.length > 0 ? new Date(series[series.length - 1].date) : new Date();
      const dayMs = 24 * 60 * 60 * 1000;
      for (let h = 1; h <= horizonDays; h++) {
        const nextDate = new Date(lastDate.getTime() + h * dayMs);
        futureDaily.push({
          dayOffset: h,
          date: nextDate.toISOString().split('T')[0],
          p50: parseFloat(dailyMean.toFixed(2)),
          p90: parseFloat((dailyMean * 1.5).toFixed(2))
        });
      }

      return {
        modelName: 'BASELINE_MINMAX',
        horizonDays,
        dailyMean: parseFloat(dailyMean.toFixed(2)),
        p50Qty: parseFloat(p50Total.toFixed(2)),
        p90Qty: parseFloat(p90Total.toFixed(2)),
        uncertaintyScore: 0.65,
        uncertaintyLevel: 'HIGH',
        status: 'INSUFFICIENT_DATA',
        baselines,
        classification,
        backtest: { status: 'INSUFFICIENT_DATA', mape: 0.65 },
        futureDaily
      };
    }

    // Run backtest
    const backtest = this.backtestModel(series, 7);

    // Check for Intermittent or Lumpy Demand profile
    if (classification.pattern === 'INTERMITTENT' || classification.pattern === 'LUMPY') {
      const crostonResult = this.forecastCrostonSBA(series, horizonDays);
      const modelName = classification.pattern === 'LUMPY' ? 'CROSTON_SBA_LUMPY' : 'CROSTON_INTERMITTENT';

      return {
        modelName,
        horizonDays,
        dailyMean: crostonResult.dailyMean,
        p50Qty: crostonResult.p50Qty,
        p90Qty: crostonResult.p90Qty,
        uncertaintyScore: Math.min(1.0, parseFloat((backtest.uncertaintyScore * 1.1).toFixed(2))),
        uncertaintyLevel: backtest.uncertaintyLevel,
        status: 'OPTIMAL',
        classification,
        baselines,
        backtest,
        futureDaily: crostonResult.futureDaily
      };
    }

    // Train ML Autoregressive model on all available history
    const Xall = [];
    const Yall = [];
    for (let t = 14; t < series.length; t++) {
      const feat = this.extractFeatures(series, t);
      if (feat) {
        Xall.push(feat);
        Yall.push(series[t].adjustedDemand);
      }
    }

    const beta = this.fitRidgeRegression(Xall, Yall);

    // Autoregressive multi-step roll-forward
    const futureSeries = series.map((s) => ({ ...s }));
    let p50Cumulative = 0;
    const lastDate = new Date(series[series.length - 1].date);
    const dayMs = 24 * 60 * 60 * 1000;
    const futureDaily = [];
    const residualStd = Math.max(0.5, backtest.rmse);

    for (let h = 1; h <= horizonDays; h++) {
      const nextDate = new Date(lastDate.getTime() + h * dayMs);
      const nextIdx = futureSeries.length;
      futureSeries.push({
        date: nextDate.toISOString().split('T')[0],
        dayOfWeek: nextDate.getUTCDay(),
        adjustedDemand: 0
      });

      const feat = this.extractFeatures(futureSeries, nextIdx);
      let pred = 0;
      if (feat) {
        for (let j = 0; j < feat.length; j++) pred += feat[j] * beta[j];
      }
      pred = Math.max(0.1, pred);
      futureSeries[nextIdx].adjustedDemand = pred;
      p50Cumulative += pred;

      const p90Step = pred + (1.28 * residualStd);
      futureDaily.push({
        dayOffset: h,
        date: nextDate.toISOString().split('T')[0],
        p50: parseFloat(pred.toFixed(2)),
        p90: parseFloat(p90Step.toFixed(2))
      });
    }

    // p90 incorporates residual uncertainty across full horizon (z=1.28 for 90th percentile)
    const p90Cumulative = p50Cumulative + (1.28 * residualStd * Math.sqrt(horizonDays));

    return {
      modelName: 'AUTOREGRESSIVE_LINEAR',
      horizonDays,
      dailyMean: parseFloat((p50Cumulative / horizonDays).toFixed(2)),
      p50Qty: parseFloat(p50Cumulative.toFixed(2)),
      p90Qty: parseFloat(p90Cumulative.toFixed(2)),
      uncertaintyScore: backtest.uncertaintyScore,
      uncertaintyLevel: backtest.uncertaintyLevel,
      status: 'OPTIMAL',
      classification,
      baselines,
      backtest,
      futureDaily
    };
  }
}

module.exports = Forecaster;
