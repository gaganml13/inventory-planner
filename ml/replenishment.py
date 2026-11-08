"""
replenishment.py — Deterministic Reorder Math & Working Capital Cash Prioritization

Implements:
1. Deterministic Safety Stock:
   SS = Z * sqrt(LeadTime * sigma_D^2 + DailyDemand^2 * sigma_L^2)  (Z = 1.65 for 95% SL)
2. Net Requirement:
   max(0, (Forecast_LeadTime + SS) - Available - Incoming)
3. Pack Size Snapping:
   Snaps requirement to whole supplier pack multiples.
4. Cash Working Capital Prioritization:
   Ranks candidates by (Unit Margin * Daily Velocity) and allocates budget
   only up to available free working capital (Operating Cash - Cash Reserve - Overdue AP).
5. Explainability Evidence Output.
"""

import math

Z_95 = 1.65
SIGMA_LEAD_DAYS = 0.5

def calculate_safety_stock(lead_days, daily_demand, daily_variance, z=Z_95, sigma_lead=SIGMA_LEAD_DAYS):
    """
    Computes statistical safety stock buffering against both demand variability and vendor lead time jitter.
    """
    variance_term = (lead_days * daily_variance) + ((daily_demand ** 2) * (sigma_lead ** 2))
    ss = z * math.sqrt(max(0.0, variance_term))
    return int(math.ceil(ss))

def evaluate_replenishment_candidate(product, forecast, history):
    """
    Evaluates reorder need for a single product catalog item.
    """
    lead_days = max(1, int(product.get('lead_days', 7)))
    pack_size = max(1, int(product.get('pack_size', 1)))
    available = int(product.get('available', 0))
    incoming = int(product.get('incoming_po', 0))
    cost_price_cents = int(product.get('cost_price_cents', 0))
    sell_price_cents = int(product.get('sell_price_cents', 0))

    daily_velocity = forecast.get('p50_daily', 0.0)

    # Compute daily demand variance from history
    quantities = [float(h.get('quantity', 0.0)) for h in history]
    if len(quantities) > 1:
        mean_q = sum(quantities) / len(quantities)
        daily_var = sum((q - mean_q) ** 2 for q in quantities) / (len(quantities) - 1)
    else:
        daily_var = (daily_velocity * 0.3) ** 2

    # 1. Deterministic Safety Stock
    safety_stock = calculate_safety_stock(lead_days, daily_velocity, daily_var)
    safety_stock = max(safety_stock, int(product.get('min_safety_stock', 0)))

    # 2. Lead Time Demand Forecast
    lead_demand = int(math.ceil(daily_velocity * lead_days))

    # 3. Net Requirement
    net_position = available + incoming
    target_inventory = lead_demand + safety_stock
    raw_deficit = max(0, target_inventory - net_position)

    if raw_deficit == 0:
        return None

    # 4. Snap to Supplier Pack Size
    packs_to_order = int(math.ceil(raw_deficit / float(pack_size)))
    recommended_qty = packs_to_order * pack_size
    total_cost_cents = recommended_qty * cost_price_cents

    # 5. Margin Velocity Priority Score
    unit_margin_cents = max(0, sell_price_cents - cost_price_cents)
    margin_velocity_score = (unit_margin_cents / 100.0) * daily_velocity

    cover_days = round(available / max(0.1, daily_velocity), 1)

    evidence = {
        'what_to_buy': {
            'sku': product['sku'],
            'name': product['name'],
            'recommended_qty': recommended_qty,
            'pack_size': pack_size,
            'packs_count': packs_to_order,
            'unit_cost_cents': cost_price_cents,
            'total_cost_cents': total_cost_cents
        },
        'why': {
            'daily_demand_velocity': round(daily_velocity, 2),
            'lead_time_days': lead_days,
            'current_cover_days': cover_days,
            'safety_stock_units': safety_stock,
            'available_stock': available,
            'incoming_po': incoming,
            'lead_demand_forecast': lead_demand,
            'trend_signal': 'ACCELERATING' if forecast.get('baselines', {}).get('ma7', 0) >= forecast.get('baselines', {}).get('ma28', 0) else 'NORMAL'
        },
        'uncertainty': {
            'score': forecast.get('uncertainty_score', 0.5),
            'level': forecast.get('uncertainty_level', 'MODERATE'),
            'model_used': forecast.get('model_name', 'AUTOREGRESSIVE'),
            'data_points': len(history)
        },
        'next_action': f"Review & Generate Draft PO for {packs_to_order} pack(s) ({recommended_qty} {product.get('base_unit', 'units')}) at ${(total_cost_cents / 100):.2f}"
    }

    return {
        'product_id': product['id'],
        'sku': product['sku'],
        'name': product['name'],
        'category': product.get('category', 'General'),
        'recommended_qty': recommended_qty,
        'packs_to_order': packs_to_order,
        'pack_size': pack_size,
        'lead_days': lead_days,
        'cost_cents': total_cost_cents,
        'unit_margin_cents': unit_margin_cents,
        'velocity': daily_velocity,
        'score': margin_velocity_score,
        'cover_days': cover_days,
        'evidence': evidence
    }

def prioritize_recommendations_by_capital(candidates, available_capital_cents):
    """
    Sorts replenishment candidates by Margin Velocity and allocates purchase orders
    strictly up to the available working capital ceiling.
    """
    # Sort descending by margin velocity score
    sorted_candidates = sorted(candidates, key=lambda c: c['score'], reverse=True)

    remaining_budget = max(0, available_capital_cents)
    results = []

    for rank, cand in enumerate(sorted_candidates, start=1):
        cost = cand['cost_cents']
        rec_qty = cand['recommended_qty']
        pack_size = cand['pack_size']
        cost_per_pack = (cost // (rec_qty // pack_size)) if rec_qty > 0 else 0

        status = 'PENDING'
        final_qty = rec_qty

        if remaining_budget >= cost:
            remaining_budget -= cost
            status = 'PENDING'
        else:
            # Partially budgetable or deferred
            affordable_packs = (remaining_budget // cost_per_pack) if cost_per_pack > 0 else 0
            if affordable_packs > 0:
                final_qty = affordable_packs * pack_size
                final_cost = affordable_packs * cost_per_pack
                remaining_budget -= final_cost
                cand['cost_cents'] = final_cost
                status = 'PARTIAL_BUDGET'
            else:
                final_qty = 0
                cand['cost_cents'] = 0
                status = 'CAPITAL_CONSTRAINED'

        cand['priority_rank'] = rank
        cand['status'] = status
        cand['recommended_qty'] = final_qty
        results.append(cand)

    return results
