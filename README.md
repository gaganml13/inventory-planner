# Smart Business Manager & Demand Forecaster for Wholesale Operators

A production-grade, enterprise-ready ERP and Decision Intelligence platform engineered for wholesale distributors, supply chain operators, and commercial merchants. Combining **Zoho Inventory's** operational clarity with **StockTrim's** demand forecasting UX. Built with **Node.js, Express, SQLite (WAL mode)**, and a dedicated **Python ML engine (`./ml`)**.

---

## 1. System Architecture

```mermaid
flowchart TD
    subgraph UI ["Modern Operational Workspace (Zoho + StockTrim Ergonomics)"]
        Sidebar["Left Sidebar (Brand, Tenant Mode Badge, 6 Nav Links, Profile & Logout)"]
        TopBar["Top Header (+ Create Dropdown, Global SKU Search, Free Capital Indicator)"]
        Dash["StockTrim Replenishment Dashboard (Capital KPIs, Cover Bars, Velocity, Urgency Badges)"]
        Drawer["Sliding Right-Hand Drawer (Demand Forecast Sparkline, Formula Breakdown, Draft PO)"]
        Onboarding["Private Workspace Onboarding Checklist (Add SKU, CSV Import, Capital Limits)"]
    end

    subgraph Auth ["Authentication & Dual-Mode Tenant Isolation"]
        LoginScreen["/login Screen (Email/Password + Explore Demo as Guest)"]
        Sessions["HTTP-Only Cookie Sessions (sessions table, 7-day TTL)"]
        Tenants["Tenant Isolation Scope (business_id enforcement across all models)"]
        DemoTenant["demo-apex-wholesale (Pre-seeded with 60d sales, inventory & forecasts)"]
        PrivateTenant["Fresh Private Workspace (Zero SKUs, Onboarding Checklist)"]
    end

    subgraph API ["REST API Layer (Express Modules)"]
        AuthRouter["/api/auth (Login, Register, Guest, Me, Logout)"]
        InvRouter["/api/inventory (Positions, Products, Adjust, Ledger Audit)"]
        OrdRouter["/api/orders (Sales & Purchase Orders Lifecycle)"]
        PayRouter["/api/payments (AR/AP & Payment Ledgers)"]
        IntelRouter["/api/intelligence (Forecasts, Recommendations & PO Generation)"]
        DataRouter["/api/data (Atomic CSV Ingestion & Hash Guard)"]
    end

    subgraph ML ["Dedicated Python ML Engine (./ml) & Internal Node Intelligence"]
        PyPipeline["ml/pipeline.py (CLI Driver & Batch Forecaster)"]
        PyFeat["ml/feature_engineering.py (Lags, Rolling Stats, Stockout Censoring)"]
        PyForecaster["ml/forecaster.py (MA7, MA28, Seasonal Naive, Ridge/Linear P50/P90)"]
        PyReplenish["ml/replenishment.py (Safety Stock Z=1.65, Pack Snapping, Budget Priority)"]
        NodeIntel["Node.js Native Intelligence Engine (Embedded fallback execution)"]
    end

    subgraph Storage ["Database & Transaction Engine"]
        Conn["Connection Manager (node:sqlite / better-sqlite3 with WAL)"]
        ImmediateTx["BEGIN IMMEDIATE Serialized Transactions"]
        DB[("inventory.db
        ├── businesses (is_demo, slug, reserves)
        ├── users & sessions
        ├── locations & contacts
        ├── products & order_lines
        ├── stock_movements (Ledger)
        ├── payment_allocations (Ledger)
        ├── demand_forecasts (P50/P90)
        └── purchase_recommendations")]
    end

    Sidebar & TopBar --> Dash & Drawer & Onboarding
    Dash --> Drawer
    Drawer --> IntelRouter
    LoginScreen --> AuthRouter --> Sessions --> Tenants
    Tenants --> DemoTenant & PrivateTenant
    UI --> API
    IntelRouter --> NodeIntel
    PyPipeline --> DB
    API --> ImmediateTx --> Conn --> DB
```

---

## 2. Key Capabilities & Engineering Highlights

### Phase 1: Authentication & Dual-Mode Tenant Isolation
- **Minimal Login Screen at `/login`:**
  - Standard email/password login and account registration.
  - 1-Click **"Explore Demo as Guest"** button.
- **Session Management:**
  - Secure random tokens stored in SQLite `sessions` table and delivered via HTTP-only, `SameSite=Lax` cookies.
- **Tenant Isolation:**
  - **Guest Mode:** Automatically binds to pre-seeded `demo-apex-wholesale` containing realistic products, inventory levels, sales orders, and pre-computed forecasts.
  - **Email User:** Automatically registers or resolves a private `business_id` tenant with zero initial catalog items, showing a guided onboarding checklist (*Add Your First SKU*, *Import Catalog via CSV*, *Set Working Capital Limit*).
  - All queries and models enforce `req.user.businessId` scoping.

### Phase 2: Zoho + StockTrim UI/UX Ergonomics
- **Left Sidebar Navigation:**
  - Brand icon, Business Name, and Mode Badge (`Demo Guest` vs `Private Workspace`).
  - Navigation links: **Overview & Replenishment**, **Catalog & Inventory**, **Purchasing (PO)**, **Sales Orders**, **Payments & Cash Flow**, **ML Demand Forecasts**.
  - Bottom profile avatar with user email and logout trigger.
- **Top Header Bar:**
  - Global SKU search bar filtering catalog and recommendation tables instantly.
  - Working Capital Reserve indicator pill (Free Capital vs Cash Reserve).
  - `+ Create` dropdown menu (*New PO*, *New Sale*, *Adjust Stock*, *Add Product*, *Import CSV*).
- **StockTrim-Style Replenishment Dashboard:**
  - **Hero Metric Cards:**
    - *Working Capital Available:* Cash minus upcoming 14-day AP obligations.
    - *Stockout Risk:* Count of SKUs with Days-of-Cover < Supplier Lead Time.
    - *Critical Purchase Commitments:* Total PO cost of high-priority restocks.
  - **Replenishment Recommendations Table:**
    - Sortable table showing `Rank`, `SKU & Description`, `Stock Status` (color-coded Days-of-Cover indicator bar), `On Hand / Incoming`, `Daily Velocity`, `Recommended Reorder` (Units & Vendor Packs), `Estimated Cost`, `Urgency Badge` (Critical / Moderate / Stable), and `Actions`.
  - **Sliding Right-Hand Drawer:**
    - Opens when clicking any row or details button in the replenishment table.
    - Displays interactive SVG Demand Forecast sparkline comparing 14-day historical sales vs P50/P90 projections.
    - Explicit mathematical formula breakdown:
      $$\text{NetRequirement} = \max(0, [\text{LeadDemand} + \text{SafetyStock}] - \text{Available} - \text{Incoming})$$
    - Supplier pack size constraints, unit costs, and lead times.
    - 1-Click **`[Generate Draft PO]`** action that transitions the recommendation into an open Purchase Order.

### Phase 3: Dedicated Python ML Engine (`./ml`)
- **`ml/requirements.txt`:** `pandas`, `numpy`, `scikit-learn`, `lightgbm`.
- **`ml/feature_engineering.py`:**
  - Lags (`lag_1`, `lag_7`, `lag_14`).
  - Rolling statistics (7-day and 14-day rolling mean, rolling standard deviation).
  - Calendar encodings (`day_of_week`, `is_weekend`).
  - **Stockout Censoring Correction:** Detects zero-demand days where inventory was zero, adjusting observations to avoid depressive downward bias on customer demand.
- **`ml/forecaster.py`:**
  - Benchmark Baselines: MA7, MA28, Seasonal Naive ($t - 7$).
  - Autoregressive Model: Multi-step recursive forecasting ($h = 14$ days).
  - Quantile Projections: P50 expected demand and P90 peak demand.
  - **Rolling-Origin Backtesting:** Enforces zero future-data leakage; training partition dates strictly precede test observation timestamps.
  - **Guardrail:** If history has $< 14$ sales events, flags `INSUFFICIENT_DATA` and safely falls back to baseline min/max logic.
- **`ml/replenishment.py`:**
  - Statistical Safety Stock:
    $$SS = Z \times \sqrt{L \times \sigma_D^2 + D^2 \times \sigma_L^2} \quad (Z = 1.65 \text{ for 95\% service level})$$
  - Net Requirement snapped to whole supplier pack multiples.
  - Margin-Velocity Cash Prioritization: Ranks reorder candidates by $(\text{Unit Margin} \times \text{Daily Velocity})$ and limits purchase orders to available working capital.
- **`ml/pipeline.py`:** CLI entry point reading SQLite, calculating forecasts and recommendations, and updating the database.

---

## 3. REST API Endpoint Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/auth/login` | Authenticate email user and issue HTTP-only session cookie |
| `POST` | `/api/auth/register` | Register new user with private isolated workspace |
| `POST` | `/api/auth/guest` | 1-Click guest login to `demo-apex-wholesale` sandbox |
| `POST` | `/api/auth/logout` | Terminate session and clear cookie |
| `GET` | `/api/auth/me` | Current session details, user mode, and business profile |
| `POST` | `/api/auth/settings/capital` | Update tenant cash reserve & operating liquidity limits |
| `GET` | `/api/metrics` | Executive capital indicators (Working Capital Available, Stockout Risk, Critical PO Commitments) |
| `GET` | `/api/inventory/positions` | List stock positions (`on_hand`, `reserved`, `available`, `incoming_po`, `net_position`) |
| `POST` | `/api/inventory/products` | Add new product SKU to catalog |
| `PUT` | `/api/inventory/products/:id` | Edit product SKU specifications, prices, lead time, pack size & safety stock |
| `DELETE` | `/api/inventory/products/:id` | Delete product and associated records (enforces open order locks) |
| `POST` | `/api/inventory/adjust` | Record stock adjustment with custom count / delta & explicit audit reasons |
| `GET` | `/api/inventory/movements` | Retrieve immutable stock movement audit ledger |
| `GET` | `/api/contacts` | List contacts with open AR / AP balances |
| `POST` | `/api/contacts` | Create customer or supplier with credit terms |
| `PUT` | `/api/contacts/:id` | Edit customer or supplier details & credit limits |
| `DELETE` | `/api/contacts/:id` | Delete contact (enforces open order locks) |
| `GET` | `/api/orders` | List commercial orders (filter by `type`, `status`, `contact_id`) |
| `POST` | `/api/orders` | Create multi-line commercial order (SALE, PURCHASE, RETURN) |
| `POST` | `/api/payments` | Record payment allocation with over-allocation prevention |
| `GET` | `/api/payments/summary` | Financial summary (AR, AP, 14d AP, Overdue aging) |
| `GET` | `/api/intelligence/recommendations` | Get StockTrim replenishment recommendations |
| `POST` | `/api/intelligence/recommendations/recompute` | Run forecasting & replenishment optimizer |
| `POST` | `/api/intelligence/recommendations/:id/create-po` | Generate Draft Purchase Order from recommendation |
| `GET` | `/api/intelligence/forecasts/:productId` | Retrieve daily history, P50/P90 forecasts & backtesting metrics |
| `POST` | `/api/data/import` | Ingest CSV data with SHA-256 line hash duplicate detection & atomic rollback |

---

## 4. Verification & Test Suite

The project includes an automated test suite executed via Node.js native test runner (`node:test` and `node:assert`):

```bash
npm test
```

### Test Suite Matrix (9 Suites — 100% Passing)
1. **`tests/auth_tenancy.test.js`**:
   - Asserts guest login binds to `demo-apex-wholesale` containing pre-seeded catalog items.
   - Verifies registered email users receive an isolated private tenant with 0 SKUs.
   - Confirms zero data leakage between guest demo and private workspaces.
2. **`tests/http_integration.test.js`**:
   - Asserts unauthenticated requests return 401.
   - Proves guest login sets valid HTTP-only session cookie.
   - Verifies StockTrim-style replenishment metrics and drawer data.
   - Confirms post-logout cookie invalidation.
3. **`tests/operational_crud_and_intelligence.test.js`**:
   - Verifies "Run Pipeline" returns clean structured JSON without unformatted HTML.
   - Verifies "Generate Draft PO" converts recommendation to purchase order, binds supplier and location, and changes status to `ORDERED`.
   - Tests complete Product CRUD (Edit, Delete) and Contact CRUD (Create, Edit, Delete).
   - Confirms stock adjustments with custom counts and audit reasons (`Physical Recount`, `Damaged`, `Supplier Delivery`).
   - Asserts metrics includes `inventoryAssetValueCents` and `topReorderPriorities`.
4. **`tests/stock_reconciliation.test.js`**:
   - Asserts inventory cannot drop below zero under unauthorized deductions.
   - Verifies exact audit rows in the `stock_movements` ledger.
5. **`tests/partial_payments.test.js`**:
   - Proves partial payment allocations update `paid_cents` and order balances accurately.
   - Confirms Accounts Receivable and Accounts Payable update in real time.
   - Enforces rejection of payments exceeding the remaining order balance.
6. **`tests/duplicate_import.test.js`**:
   - Proves duplicate CSV line hashes are rejected with `409 Conflict`.
   - Confirms complete transaction rollback with zero partial database mutations.
7. **`tests/forecast_leakage.test.js`**:
   - Strictly asserts training cutoff dates precede test observation window timestamps (zero future-data leakage).
   - Verifies feature extraction uses only strictly prior lags.
   - Validates that sparse data ($< 14$ sales events) flags `INSUFFICIENT_DATA` and falls back to baseline min/max logic.
8. **`tests/purchase_budget.test.js`**:
   - Confirms purchase recommendations never exceed available working capital after deducting mandatory cash reserves and pending debt obligations.
   - Asserts priority ranking follows Margin Velocity.
   - Enforces rejection of payments exceeding the remaining order balance.
5. **`tests/duplicate_import.test.js`**:
   - Proves duplicate CSV line hashes are rejected with `409 Conflict`.
   - Confirms complete transaction rollback with zero partial database mutations.
6. **`tests/forecast_leakage.test.js`**:
   - Strictly asserts training cutoff dates precede test observation window timestamps (zero future-data leakage).
   - Verifies feature extraction uses only strictly prior lags.
   - Validates that sparse data ($< 14$ sales events) flags `INSUFFICIENT_DATA` and falls back to baseline min/max logic.
7. **`tests/purchase_budget.test.js`**:
   - Confirms purchase recommendations never exceed available working capital after deducting mandatory cash reserves and pending debt obligations.
   - Asserts priority ranking follows Margin Velocity.

---

## 5. Quickstart & Local Setup

### Prerequisites
- Node.js `v18.0.0+` (Node 20, 22, or 24 native SQLite engine).

### Installation & Run

```bash
# 1. Navigate to the project directory
cd inventory-planner

# 2. Run automated test suite
npm test

# 3. Seed database with realistic wholesale operations
npm run seed

# 4. Start the application
npm start
```

Open your browser to:
```
http://localhost:3000
```
- Click **"Explore Demo as Guest"** to test pre-seeded demand forecasts and replenishable SKUs.
- Or create a **Private Workspace** with the onboarding checklist (*Add SKU*, *CSV Import*, *Set Capital*).

### Provisioning Benchmark Test Data (3 Distinct Patterns)
```bash
# Via Python CLI:
python ml/setup_test_dataset.py --business_id=1

# Or via API:
curl -X POST http://localhost:3000/api/intelligence/seed-benchmark-data -H "Cookie: session=<token>"
```
- **3 Benchmark SKUs:**
  * `TEST-FAST-01`: High-velocity daily mover (25–60 units/day, lead time: 5d).
  * `TEST-STEADY-02`: Weekday steady mover (8–14 units Mon–Fri, 0–2 units weekends, lead time: 7d).
  * `TEST-LUMPY-03`: Sporadic batch burst mover (batch bursts of 12–25 units every 8–12 days, lead time: 14d).
- **Relational Integrity:** Ensures `orders.contact_id NOT NULL` is strictly satisfied with a valid customer contact (`Wholesale Retailer Alpha`) and generates 45 contiguous days of sales history with balanced stock ledger movements.

### Running the Python ML Pipeline (Optional Standalone)
```bash
cd inventory-planner/ml
pip install -r requirements.txt
python train_model.py --business_id=1
```
- **Requirements:** `pandas`, `numpy`, `scikit-learn`, `lightgbm`.
- **Pipeline:** Chronological 80/20 train/test split, autoregressive lags (`lag_1` to `lag_28`), rolling statistics (`rolling_mean_7`, `rolling_mean_14`, `rolling_std_7`, `rolling_max_14`), calendar seasonality (`day_of_week`, `is_weekend`, `day_of_month`), 14-day recursive multi-step forecasting with P50/P90 quantiles, and statistical safety stock buffer computation ($SS = 1.65 \times \sqrt{LeadTime \times \sigma_D^2 + \bar{D}^2 \times \sigma_L^2}$).
- **Persistence:** Results stored in `demand_forecasts`, accuracy metrics logged to `ml_training_runs` table, and replenishment priorities refreshed in `purchase_recommendations`.
*(The Express application includes embedded native fallbacks that execute cleanly and return structured JSON without ever producing unhandled HTML 500 pages.)*
