"""
feature_engineering.py — Time-Series Feature Transformation & Demand Censoring Correction

Features engineered:
- Demand Censoring Adjustment: Identifies zero-demand days where inventory was 0 (stockout),
  replacing them with the preceding rolling average to avoid depressive bias.
- Autoregressive Lags: lag_1, lag_7, lag_14.
- Rolling Statistics: rolling_mean_7, rolling_mean_14, rolling_std_7.
- Calendar Features: day_of_week (0-6), is_weekend (0/1).
"""

import math
from datetime import datetime, timedelta

def adjust_censored_demand(observations):
    """
    Adjusts demand observations for stockouts.
    observations: list of dicts: {'date': 'YYYY-MM-DD', 'quantity': float, 'on_hand': float}
    """
    cleaned = []
    recent_positive = []

    for obs in observations:
        qty = float(obs.get('quantity', 0.0))
        on_hand = float(obs.get('on_hand', 1.0))
        is_censored = (qty == 0.0 and on_hand <= 0.0)

        if is_censored and len(recent_positive) > 0:
            # Substitute with moving average of recent un-censored days
            imputed = sum(recent_positive[-7:]) / len(recent_positive[-7:])
            cleaned.append({
                'date': obs['date'],
                'quantity': round(imputed, 2),
                'raw_quantity': qty,
                'is_censored': True
            })
        else:
            cleaned.append({
                'date': obs['date'],
                'quantity': qty,
                'raw_quantity': qty,
                'is_censored': False
            })
            if qty > 0:
                recent_positive.append(qty)

    return cleaned

def build_feature_matrix(series):
    """
    Constructs autoregressive lag and rolling feature matrix from a continuous daily series.
    series: list of dicts with 'date' and 'quantity'.
    Returns:
      X (list of feature dicts/vectors), y (list of target values)
    """
    if len(series) < 15:
        return [], []

    rows = []
    targets = []

    quantities = [float(s['quantity']) for s in series]
    dates = [s['date'] for s in series]

    # Generate lag indices
    for t in range(14, len(series)):
        qty_target = quantities[t]
        dt = datetime.fromisoformat(dates[t].replace('Z', ''))

        lag_1 = quantities[t - 1]
        lag_7 = quantities[t - 7]
        lag_14 = quantities[t - 14]

        window_7 = quantities[t - 7:t]
        rolling_mean_7 = sum(window_7) / len(window_7)
        variance_7 = sum((x - rolling_mean_7) ** 2 for x in window_7) / len(window_7)
        rolling_std_7 = math.sqrt(variance_7)

        window_14 = quantities[t - 14:t]
        rolling_mean_14 = sum(window_14) / len(window_14)

        day_of_week = dt.weekday()
        is_weekend = 1 if day_of_week in [5, 6] else 0

        features = {
            'lag_1': lag_1,
            'lag_7': lag_7,
            'lag_14': lag_14,
            'rolling_mean_7': rolling_mean_7,
            'rolling_std_7': rolling_std_7,
            'rolling_mean_14': rolling_mean_14,
            'day_of_week': day_of_week,
            'is_weekend': is_weekend
        }

        rows.append(features)
        targets.append(qty_target)

    return rows, targets
