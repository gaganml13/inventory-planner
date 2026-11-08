#!/usr/bin/env python3
"""
setup_test_dataset.py — Self-Contained Benchmark Test Data Provisioning Script

Inspects table schemas via PRAGMA table_info and provisions:
1. Valid customer contact ('Wholesale Retailer Alpha') satisfying `orders.contact_id NOT NULL`.
2. 3 distinct benchmark products exhibiting distinct ML demand patterns:
   - TEST-FAST-01: High velocity (25 - 60 units/day)
   - TEST-STEADY-02: Weekday steady (8 - 14 units Mon-Fri, 0 - 2 units weekends)
   - TEST-LUMPY-03: Sporadic bursts (0 units most days, batch spikes of 12 - 25 units)
3. 45 days of realistic daily sales order history respecting all relational foreign keys
   (business_id, contact_id, product_id, order_id, location_id).
4. Idempotent: can be executed multiple times without constraint violations.
"""

import sys
import os
import argparse
import sqlite3
import json
import math
from datetime import datetime, timedelta

def resolve_db_path(cli_db):
    if cli_db:
        return os.path.abspath(cli_db)
    data_dir = os.environ.get('DATA_DIR')
    if data_dir:
        os.makedirs(data_dir, exist_ok=True)
        return os.path.abspath(os.path.join(data_dir, 'inventory.db'))
    candidates = [
        os.path.join(os.getcwd(), 'inventory.db'),
        os.path.join(os.path.dirname(__file__), '..', 'inventory.db'),
        os.path.join(os.path.dirname(__file__), 'inventory.db')
    ]
    for p in candidates:
        if os.path.exists(p):
            return os.path.abspath(p)
    return os.path.abspath(candidates[0])

def inspect_schemas(conn):
    """
    Directly checks existing table schemas via PRAGMA table_info.
    """
    tables = ['orders', 'order_lines', 'products', 'contacts', 'locations', 'stock_movements']
    schemas = {}
    for t in tables:
        rows = conn.execute(f"PRAGMA table_info({t})").fetchall()
        schemas[t] = {r['name']: {'type': r['type'], 'notnull': r['notnull'], 'pk': r['pk']} for r in rows}
    return schemas

def setup_benchmark_dataset(db_path, business_id=1):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    schemas = inspect_schemas(conn)
    if 'orders' not in schemas or 'products' not in schemas:
        raise RuntimeError("Database missing core tables. Run migrations first.")

    now = datetime.utcnow()
    day_ms = timedelta(days=1)

    conn.execute("BEGIN IMMEDIATE")
    try:
        # 1. Ensure Business exists
        biz = conn.execute("SELECT id FROM businesses WHERE id = ?", (business_id,)).fetchone()
        if not biz:
            conn.execute("""
            INSERT INTO businesses (id, name, currency, cash_reserve_cents, operating_cash_cents, slug, is_demo)
            VALUES (?, 'Vanguard Wholesale Corp', 'USD', 5000000, 18500000, 'demo-vanguard-wholesale', 1)
            """, (business_id,))

        # 2. Ensure Location exists
        loc = conn.execute("SELECT id FROM locations WHERE business_id = ? LIMIT 1", (business_id,)).fetchone()
        if loc:
            location_id = loc['id']
        else:
            cur = conn.execute("""
            INSERT INTO locations (business_id, name, description)
            VALUES (?, 'Primary Distribution Depot', 'Benchmark logistics facility')
            """, (business_id,))
            location_id = cur.lastrowid

        # 3. Ensure Customer Contact exists (RESOLVES orders.contact_id NOT NULL constraint)
        cust = conn.execute("""
        SELECT id FROM contacts WHERE type = 'CUSTOMER' AND business_id = ? LIMIT 1
        """, (business_id,)).fetchone()
        if cust:
            customer_id = cust['id']
        else:
            cur = conn.execute("""
            INSERT INTO contacts (business_id, type, name, email, phone, credit_limit_cents, payment_terms_days)
            VALUES (?, 'CUSTOMER', 'Wholesale Retailer Alpha', 'orders@alpha.example.com', '+1-555-0100', 5000000, 30)
            """, (business_id,))
            customer_id = cur.lastrowid

        # 4. Ensure Supplier Contact exists
        sup = conn.execute("""
        SELECT id FROM contacts WHERE type = 'SUPPLIER' AND business_id = ? LIMIT 1
        """, (business_id,)).fetchone()
        if sup:
            supplier_id = sup['id']
        else:
            cur = conn.execute("""
            INSERT INTO contacts (business_id, type, name, email, phone, credit_limit_cents, payment_terms_days)
            VALUES (?, 'SUPPLIER', 'Global Component Supply', 'supply@globalcomponent.example.com', '+1-555-0199', 0, 30)
            """, (business_id,))
            supplier_id = cur.lastrowid

        # 5. Define 3 Benchmark Products with distinct ML demand patterns
        benchmarks = [
            {
                'sku': 'TEST-FAST-01',
                'barcode': '999000100001',
                'name': 'Ultra-Speed Fast Mover Cable 1m',
                'category': 'Electronics',
                'base_unit': 'pcs',
                'pack_size': 10,
                'lead_days': 5,
                'min_safety_stock': 50,
                'cost_price_cents': 400,    # $4.00
                'sell_price_cents': 950,    # $9.50
                'initial_stock': 2500,
                'pattern': 'high_velocity'
            },
            {
                'sku': 'TEST-STEADY-02',
                'barcode': '999000100002',
                'name': 'Standard Ergonomic Desktop Stand',
                'category': 'Hardware',
                'base_unit': 'pcs',
                'pack_size': 4,
                'lead_days': 7,
                'min_safety_stock': 20,
                'cost_price_cents': 1500,   # $15.00
                'sell_price_cents': 3200,   # $32.00
                'initial_stock': 800,
                'pattern': 'weekday_steady'
            },
            {
                'sku': 'TEST-LUMPY-03',
                'barcode': '999000100003',
                'name': 'Industrial High-Capacity Server Rack',
                'category': 'Infrastructure',
                'base_unit': 'pcs',
                'pack_size': 1,
                'lead_days': 14,
                'min_safety_stock': 5,
                'cost_price_cents': 45000,  # $450.00
                'sell_price_cents': 85000,  # $850.00
                'initial_stock': 120,
                'pattern': 'sporadic_bursts'
            }
        ]

        product_map = {}
        for b in benchmarks:
            existing = conn.execute("""
            SELECT id FROM products WHERE business_id = ? AND sku = ?
            """, (business_id, b['sku'])).fetchone()

            if existing:
                prod_id = existing['id']
                conn.execute("""
                UPDATE products SET
                    barcode = ?, name = ?, category = ?, pack_size = ?,
                    lead_days = ?, min_safety_stock = ?, cost_price_cents = ?,
                    sell_price_cents = ?
                WHERE id = ?
                """, (b['barcode'], b['name'], b['category'], b['pack_size'],
                      b['lead_days'], b['min_safety_stock'], b['cost_price_cents'],
                      b['sell_price_cents'], prod_id))
            else:
                cur = conn.execute("""
                INSERT INTO products (
                    business_id, sku, barcode, name, category, base_unit,
                    pack_size, lead_days, min_safety_stock, cost_price_cents,
                    sell_price_cents, source_tag
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BENCHMARK')
                """, (business_id, b['sku'], b['barcode'], b['name'], b['category'],
                      b['base_unit'], b['pack_size'], b['lead_days'], b['min_safety_stock'],
                      b['cost_price_cents'], b['sell_price_cents']))
                prod_id = cur.lastrowid

            product_map[b['sku']] = {**b, 'id': prod_id}

        # 6. Idempotently clean up prior benchmark orders and stock movements
        conn.execute("""
        DELETE FROM orders WHERE business_id = ? AND order_number LIKE 'BM-SO-%'
        """, (business_id,))

        for b in benchmarks:
            conn.execute("""
            DELETE FROM stock_movements 
            WHERE business_id = ? AND product_id = ? AND (source_tag = 'BENCHMARK' OR reason LIKE 'BENCHMARK_%')
            """, (business_id, product_map[b['sku']]['id']))

        # 7. Provision Initial Stock Movements 46 days ago
        initial_time = (now - timedelta(days=46)).strftime('%Y-%m-%dT08:00:00.000Z')
        current_balances = {}
        for b in benchmarks:
            pid = product_map[b['sku']]['id']
            qty = b['initial_stock']
            current_balances[pid] = qty
            conn.execute("""
            INSERT INTO stock_movements (
                business_id, product_id, location_id, change_qty,
                balance_after, reason, order_line_id, source_tag, created_at
            ) VALUES (?, ?, ?, ?, ?, 'BENCHMARK_INITIAL_COUNT', NULL, 'BENCHMARK', ?)
            """, (business_id, pid, location_id, qty, qty, initial_time))

        # 8. Generate 45 Days of Realistic Daily Sales Order History
        burst_offsets = {40, 31, 22, 13, 4}

        for day_offset in range(45, 0, -1):
            order_date_dt = now - timedelta(days=day_offset)
            order_date_str = order_date_dt.strftime('%Y-%m-%d')
            order_iso = order_date_dt.strftime('%Y-%m-%dT14:00:00.000Z')
            due_iso = (order_date_dt + timedelta(days=15)).strftime('%Y-%m-%dT18:00:00.000Z')
            dow = order_date_dt.weekday() # 0 = Mon, 6 = Sun

            daily_items = []

            # 1. TEST-FAST-01: High velocity (25 - 60 units/day)
            fast_base = 40.0
            dow_multiplier = 1.3 if dow in (1, 2, 3, 4) else (1.0 if dow == 0 else 0.7)
            trend = 1.0 + (45 - day_offset) * 0.004 # +18% gradual trend
            fast_qty = int(round(fast_base * dow_multiplier * trend + (day_offset % 7 - 3)))
            fast_qty = max(20, min(65, fast_qty))
            daily_items.append(('TEST-FAST-01', fast_qty))

            # 2. TEST-STEADY-02: Weekday steady (8 - 14 units Mon-Fri, 0 - 2 units Sat-Sun)
            if dow in (0, 1, 2, 3, 4):
                steady_qty = 8 + (day_offset % 7) # 8 to 14 units
            else:
                steady_qty = 1 if (day_offset % 2 == 0) else 0 # 0 to 1 unit
            if steady_qty > 0:
                daily_items.append(('TEST-STEADY-02', steady_qty))

            # 3. TEST-LUMPY-03: Sporadic bursts (0 on most days, burst of 12-25 on specific dates)
            if day_offset in burst_offsets:
                lumpy_qty = 12 + (day_offset % 9) # 12 to 20 units
                daily_items.append(('TEST-LUMPY-03', lumpy_qty))

            if not daily_items:
                continue

            order_num = f"BM-SO-{business_id}-{day_offset}"
            order_total_cents = 0

            # Calculate total
            for sku, qty in daily_items:
                p_info = product_map[sku]
                order_total_cents += (qty * p_info['sell_price_cents'])

            # Insert Order satisfying foreign key constraints
            order_cur = conn.execute("""
            INSERT INTO orders (
                business_id, contact_id, order_number, type, status,
                order_date, due_date, total_cents, paid_cents, notes,
                allow_backorder, source_tag, created_at
            ) VALUES (?, ?, ?, 'SALE', 'FULFILLED', ?, ?, ?, ?, 'Benchmark historical sales fulfillment', 0, 'BENCHMARK', ?)
            """, (business_id, customer_id, order_num, order_date_str, due_iso,
                  order_total_cents, order_total_cents, order_iso))

            order_id = order_cur.lastrowid

            # Insert Order Lines and Stock Movements
            for sku, qty in daily_items:
                p_info = product_map[sku]
                pid = p_info['id']
                pack_qty = max(1, math.ceil(qty / float(p_info['pack_size'])))
                unit_price = p_info['sell_price_cents']
                line_total = qty * unit_price

                line_cur = conn.execute("""
                INSERT INTO order_lines (
                    order_id, product_id, quantity, pack_quantity,
                    unit_price_cents, tax_cents, discount_cents, total_cents
                ) VALUES (?, ?, ?, ?, ?, 0, 0, ?)
                """, (order_id, pid, qty, pack_qty, unit_price, line_total))

                line_id = line_cur.lastrowid

                new_bal = current_balances[pid] - qty
                current_balances[pid] = new_bal

                conn.execute("""
                INSERT INTO stock_movements (
                    business_id, product_id, location_id, change_qty,
                    balance_after, reason, order_line_id, source_tag, created_at
                ) VALUES (?, ?, ?, ?, ?, 'BENCHMARK_SALE_FULFILLMENT', ?, 'BENCHMARK', ?)
                """, (business_id, pid, location_id, -qty, new_bal, line_id, order_iso))

        conn.commit()

        result = {
            "success": True,
            "business_id": business_id,
            "benchmark_products": [
                {
                    "sku": b['sku'],
                    "name": b['name'],
                    "pattern": b['pattern'],
                    "product_id": product_map[b['sku']]['id'],
                    "closing_stock": current_balances[product_map[b['sku']]['id']]
                }
                for b in benchmarks
            ],
            "days_generated": 45,
            "customer_id": customer_id,
            "location_id": location_id,
            "status": "COMPLETED"
        }
        return result

    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()

def main():
    parser = argparse.ArgumentParser(description="Provision Benchmark Test Dataset for Inventory Forecaster")
    parser.add_argument('--business_id', type=int, default=1, help="Tenant business ID")
    parser.add_argument('--business-id', type=int, default=None, help="Alias for business_id")
    parser.add_argument('--db', type=str, default=None, help="Path to SQLite database")
    args = parser.parse_args()

    biz_id = args.business_id if args.business_id is not None else (args.business_id or 1)
    db_path = resolve_db_path(args.db)

    res = setup_benchmark_dataset(db_path, biz_id)
    print(json.dumps(res, indent=2))

if __name__ == "__main__":
    main()
