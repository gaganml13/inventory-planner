import sqlite3, datetime, random

conn = sqlite3.connect('inventory.db')
cursor = conn.cursor()

# 1. Resolve business ID (an integer)
cursor.execute("SELECT id FROM businesses WHERE name LIKE '%AlgoTraders%' OR id = 2 LIMIT 1")
biz_row = cursor.fetchone()
if not biz_row:
    cursor.execute("SELECT id FROM businesses LIMIT 1")
    biz_row = cursor.fetchone()

biz_id = biz_row[0] if biz_row else 1
print(f"Using business ID: {biz_id}")

# 2. Insert 3 distinct test products (let SQLite auto-generate integer IDs)
products_meta = [
    ('TEST-FAST-01', 'BC-001', 'Thermal Paper Rolls 80mm', 'Consumables', 150, 350, 10, 4, 20),
    ('TEST-STEADY-02', 'BC-002', 'Ballpoint Pens 50pk', 'Office Supplies', 320, 600, 5, 7, 15),
    ('TEST-LUMPY-03', 'BC-003', 'Heavy Duty Packing Tape', 'Packaging', 450, 900, 6, 10, 10)
]

product_ids = {}
for sku, barcode, name, cat, cost, sell, pack, lead, safety in products_meta:
    # Remove existing product if present to avoid duplicate SKUs
    cursor.execute("SELECT id FROM products WHERE sku = ?", (sku,))
    existing = cursor.fetchone()
    if existing:
        cursor.execute("DELETE FROM order_lines WHERE product_id = ?", (existing[0],))
        cursor.execute("DELETE FROM products WHERE id = ?", (existing[0],))

    cursor.execute("""
        INSERT INTO products (business_id, sku, barcode, name, category, cost_price_cents, sell_price_cents, pack_size, lead_days, min_safety_stock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (biz_id, sku, barcode, name, cat, cost, sell, pack, lead, safety))
    product_ids[sku] = cursor.lastrowid

print("Products inserted successfully with auto-generated IDs:", product_ids)

# 3. Seed 35 days of sales records
today = datetime.date.today()

for i in range(35, 0, -1):
    day = today - datetime.timedelta(days=i)
    date_str = f"{day.isoformat()} 12:00:00"
    is_weekend = day.weekday() in (5, 6)

    # Let order id be auto-generated or numeric
    cursor.execute("""
        INSERT INTO orders (business_id, type, status, total_cents, paid_cents, created_at)
        VALUES (?, 'SALE', 'FULFILLED', 7500, 7500, ?)
    """, (biz_id, date_str))
    order_id = cursor.lastrowid

    # Fast SKU: Weekdays 20-30 pcs, Weekends 8-12 pcs
    q1 = random.randint(8, 12) if is_weekend else random.randint(20, 30)
    cursor.execute("""
        INSERT INTO order_lines (order_id, product_id, quantity, pack_quantity, unit_price_cents)
        VALUES (?, ?, ?, 1, 350)
    """, (order_id, product_ids['TEST-FAST-01'], q1))

    # Steady SKU: Weekdays 5-7 pcs, Weekends 0 pcs
    q2 = 0 if is_weekend else random.randint(5, 7)
    cursor.execute("""
        INSERT INTO order_lines (order_id, product_id, quantity, pack_quantity, unit_price_cents)
        VALUES (?, ?, ?, 1, 600)
    """, (order_id, product_ids['TEST-STEADY-02'], q2))

    # Lumpy SKU: Bursts of 25 pcs every 6 days, otherwise 0
    q3 = 25 if (i % 6 == 0) else 0
    cursor.execute("""
        INSERT INTO order_lines (order_id, product_id, quantity, pack_quantity, unit_price_cents)
        VALUES (?, ?, ?, 1, 900)
    """, (order_id, product_ids['TEST-LUMPY-03'], q3))

conn.commit()
conn.close()
print("Success! Created 3 products and injected 35 days of daily sales records.")
