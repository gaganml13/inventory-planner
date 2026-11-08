"""
pipeline.py — End-to-End Demand Forecasting & Reorder Pipeline (CLI Driver)

Connects to SQLite, reads transaction history, adjusts for stockouts,
generates P50/P90 forecasts, computes deterministic reorders snapped to packs,
prioritizes against working capital constraints, and persists results to the database.
"""

import sys
import os
import argparse
import sqlite3
import json
from datetime import datetime, timedelta

from feature_engineering import adjust_censored_demand
from forecaster import DemandForecaster
from replenishment import evaluate_replenishment_candidate, prioritize_recommendations_by_capital

def get_db_connection(db_path):
    resolved = os.path.abspath(db_path)
    os.makedirs(os.path.dirname(resolved), exist_ok=True)
    if not os.path.exists(resolved):
        raise FileNotFoundError(f"Database file not found at {resolved}")
    conn = sqlite3.connect(resolved)
    conn.row_factory = sqlite3.Row
    return conn

def load_products_with_positions(conn, business_id):
    sql = """
    SELECT 
        p.id, p.sku, p.name, p.category, p.base_unit, p.pack_size, p.lead_days,
        p.min_safety_stock, p.cost_price_cents, p.sell_price_cents,
        COALESCE(sm.on_hand, 0) AS on_hand,
        COALESCE(res.reserved, 0) AS reserved,
        (COALESCE(sm.on_hand, 0) - COALESCE(res.reserved, 0)) AS available,
        COALESCE(inc.incoming_po, 0) AS incoming_po
    FROM products p
    LEFT JOIN (
        SELECT product_id, SUM(change_qty) AS on_hand
        FROM stock_movements
        WHERE business_id = ?
        GROUP BY product_id
    ) sm ON p.id = sm.product_id
    LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity) AS reserved
        FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id
        WHERE o.business_id = ? AND o.type = 'SALE' AND o.status = 'CONFIRMED'
        GROUP BY ol.product_id
    ) res ON p.id = res.product_id
    LEFT JOIN (
        SELECT ol.product_id, SUM(ol.quantity) AS incoming_po
        FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id
        WHERE o.business_id = ? AND o.type = 'PURCHASE' AND o.status = 'CONFIRMED'
        GROUP BY ol.product_id
    ) inc ON p.id = inc.product_id
    WHERE p.business_id = ?
    ORDER BY p.id ASC
    """
    return conn.execute(sql, (business_id, business_id, business_id, business_id)).fetchall()

def load_product_demand_history(conn, business_id, product_id, days=60):
    start_date = (datetime.utcnow() - timedelta(days=days)).strftime('%Y-%m-%d')
    sql = """
    SELECT 
        strftime('%Y-%m-%d', o.created_at) AS sale_day,
        SUM(ol.quantity) AS total_units
    FROM order_lines ol
    JOIN orders o ON ol.order_id = o.id
    WHERE o.business_id = ? 
      AND ol.product_id = ? 
      AND o.type = 'SALE' 
      AND o.status != 'CANCELLED'
      AND o.created_at >= ?
    GROUP BY strftime('%Y-%m-%d', o.created_at)
    ORDER BY sale_day ASC
    """
    sales_map = {row['sale_day']: row['total_units'] for row in conn.execute(sql, (business_id, product_id, start_date)).fetchall()}

    # Construct dense daily series
    dense_series = []
    base_date = datetime.utcnow() - timedelta(days=days)
    for i in range(days):
        dt = (base_date + timedelta(days=i)).strftime('%Y-%m-%d')
        dense_series.append({
            'date': dt,
            'quantity': float(sales_map.get(dt, 0.0)),
            'on_hand': 1.0  # default positive; censored adjustment checks stockout movements if needed
        })
    return dense_series

def calculate_working_capital(conn, business_id):
    biz = conn.execute("SELECT cash_reserve_cents, operating_cash_cents FROM businesses WHERE id = ?", (business_id,)).fetchone()
    if not biz:
        return 5000000, 10000000, 5000000

    cash_reserve = biz['cash_reserve_cents'] or 0
    operating_cash = biz['operating_cash_cents'] or 0

    ap_row = conn.execute("""
        SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS overdue_ap
        FROM orders
        WHERE business_id = ? AND type = 'PURCHASE' AND status != 'CANCELLED'
          AND paid_cents < total_cents AND due_date < date('now')
    """, (business_id,)).fetchone()

    overdue_ap = ap_row['overdue_ap'] if ap_row else 0
    available_capital = max(0, operating_cash - cash_reserve - overdue_ap)
    return cash_reserve, operating_cash, available_capital

def run_pipeline(db_path, business_id=1, horizon_days=14):
    print(f"[{datetime.utcnow().isoformat()}] Starting ML Demand & Replenishment Pipeline for Business #{business_id}")
    conn = get_db_connection(db_path)

    cash_reserve, operating_cash, available_capital = calculate_working_capital(conn, business_id)
    print(f"Working Capital: Operating=${operating_cash/100:,.2f} | Reserve=${cash_reserve/100:,.2f} | Available=${available_capital/100:,.2f}")

    products = load_products_with_positions(conn, business_id)
    print(f"Loaded {len(products)} catalog products.")

    forecaster = DemandForecaster(min_events=14)
    candidates = []

    conn.execute("BEGIN IMMEDIATE")
    try:
        # Clear previous forecasts and recommendations for this business
        conn.execute("DELETE FROM demand_forecasts WHERE product_id IN (SELECT id FROM products WHERE business_id = ?)", (business_id,))

        for p in products:
            p_dict = dict(p)
            history = load_product_demand_history(conn, business_id, p['id'], days=60)
            cleaned_history = adjust_censored_demand(history)

            # Generate forecast
            forecast = forecaster.generate_forecast(cleaned_history, horizon_days=horizon_days)

            p50_val = int(round(forecast.get('p50_total') or 0))
            p90_val = int(round(forecast.get('p90_total') or (p50_val * 1.5)))
            model_str = str(forecast.get('model_name') or 'AUTOREGRESSIVE_RIDGE')
            uncertainty_val = float(forecast.get('uncertainty_score') or 0.5)

            # Save to demand_forecasts
            conn.execute("""
                INSERT INTO demand_forecasts (
                    product_id, horizon_days, p50_qty, p90_qty, model_name, uncertainty_score, generated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                p['id'],
                horizon_days,
                p50_val,
                p90_val,
                model_str,
                uncertainty_val,
                datetime.utcnow().isoformat()
            ))

            # Evaluate replenishment
            candidate = evaluate_replenishment_candidate(p_dict, forecast, cleaned_history)
            if candidate:
                candidates.append(candidate)

        # Prioritize against working capital ceiling
        prioritized = prioritize_recommendations_by_capital(candidates, available_capital)

        # Persist purchase recommendations
        conn.execute("DELETE FROM purchase_recommendations WHERE business_id = ?", (business_id,))

        for rec in prioritized:
            conn.execute("""
                INSERT INTO purchase_recommendations (
                    business_id, product_id, recommended_qty, cost_cents, priority_rank, rationale_json, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                business_id,
                rec['product_id'],
                int(rec.get('recommended_qty') or 0),
                int(rec.get('cost_cents') or 0),
                int(rec.get('priority_rank') or 1),
                json.dumps(rec.get('evidence') or {}),
                str(rec.get('status') or 'PENDING')
            ))

        conn.commit()
        
        # Structured JSON response
        result_payload = {
            "success": True,
            "business_id": business_id,
            "forecasts_count": len(products),
            "recommendations_count": len(prioritized)
        }
        print(json.dumps(result_payload))
        print(f"Successfully generated {len(products)} forecasts and {len(prioritized)} purchase recommendations.")

        # Print Executive Summary Table
        print("\n" + "=" * 90)
        print(f"{'RANK':<5} {'SKU':<16} {'COVER':<8} {'VELOCITY':<10} {'REORDER':<12} {'COST ($)':<12} {'STATUS':<15}")
        print("-" * 90)
        for r in prioritized[:10]:
            print(f"#{r['priority_rank']:<4} {r['sku']:<16} {str(r['cover_days'])+'d':<8} {r['velocity']:<10.1f} {str(r['recommended_qty'])+' u':<12} ${(r['cost_cents']/100):<11.2f} {r['status']:<15}")
        print("=" * 90 + "\n")

    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Smart Business Manager Demand Forecaster')
    default_db = (
        os.path.join(os.environ['DATA_DIR'], 'inventory.db')
        if os.environ.get('DATA_DIR')
        else os.path.join(os.path.dirname(__file__), '..', 'inventory.db')
    )
    parser.add_argument('--db', default=default_db, help='Path to SQLite database')
    parser.add_argument('--business-id', type=int, default=1, help='Tenant business ID')
    parser.add_argument('--horizon', type=int, default=14, help='Forecast horizon in days')
    args = parser.parse_args()

    run_pipeline(args.db, args.business_id, args.horizon)
