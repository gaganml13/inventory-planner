import sqlite3, datetime, random

conn = sqlite3.connect('inventory.db')
cursor = conn.cursor()

# Find business ID
cursor.execute("SELECT id FROM businesses WHERE name LIKE '%AlgoTraders%' OR id LIKE '%gagan%' LIMIT 1")
biz_row = cursor.fetchone()
if not biz_row:
    cursor.execute("SELECT id FROM businesses LIMIT 1")
    biz_row = cursor.fetchone()

biz_id = biz_row[0] if biz_row else 'default'

# Retrieve SKUs
products = {}
for sku in ['TEST-FAST-01', 'TEST-STEADY-02', 'TEST-LUMPY-03']:
    cursor.execute("SELECT id FROM products WHERE sku = ?", (sku,))
    row = cursor.fetchone()
    if row:
        products[sku] = row[0]

if len(products) < 3:
    print('Error: Missing SKUs. Found:', list(products.keys()))
    print('Please import the 3 SKUs in the Catalog modal first, then re-run.')
    exit(1)

print(f'Seeding 35 days of sales history for business ID: {biz_id}')

today = datetime.date.today()

for i in range(35, 0, -1):
    day = today - datetime.timedelta(days=i)
    date_str = f'{day.isoformat()} 12:00:00'
    order_id = f'ORD-PY-HIST-{i}'
    is_weekend = day.weekday() in (5, 6)

    cursor.execute(
        "INSERT OR REPLACE INTO orders (id, business_id, type, status, total_cents, paid_cents, created_at) VALUES (?, ?, 'SALE', 'FULFILLED', 7500, 7500, ?)",
        (order_id, biz_id, date_str)
    )

    # 1. Fast Velocity (Weekday: 20-30, Weekend: 8-12)
    q1 = random.randint(8, 12) if is_weekend else random.randint(20, 30)
    cursor.execute(
        "INSERT OR REPLACE INTO order_lines (id, order_id, product_id, quantity, pack_quantity, unit_price_cents) VALUES (?, ?, ?, ?, 1, 350)",
        (f'LINE-PY-{i}-1', order_id, products['TEST-FAST-01'], q1)
    )

    # 2. Steady (Weekday: 5-7, Weekend: 0)
    q2 = 0 if is_weekend else random.randint(5, 7)
    cursor.execute(
        "INSERT OR REPLACE INTO order_lines (id, order_id, product_id, quantity, pack_quantity, unit_price_cents) VALUES (?, ?, ?, ?, 1, 600)",
        (f'LINE-PY-{i}-2', order_id, products['TEST-STEADY-02'], q2)
    )

    # 3. Lumpy Spikes (Batch bursts every ~6 days)
    q3 = 25 if (i % 6 == 0) else 0
    cursor.execute(
        "INSERT OR REPLACE INTO order_lines (id, order_id, product_id, quantity, pack_quantity, unit_price_cents) VALUES (?, ?, ?, ?, 1, 900)",
        (f'LINE-PY-{i}-3', order_id, products['TEST-LUMPY-03'], q3)
    )

conn.commit()
conn.close()
print('Successfully injected 35 days of distinct sales history!')
