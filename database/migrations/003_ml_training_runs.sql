-- 003_ml_training_runs.sql
-- ML Training Runs, Accuracy Diagnostics, and Model Registry

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ml_training_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id       INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  model_name        TEXT    NOT NULL,
  training_records  INTEGER NOT NULL DEFAULT 0,
  test_records      INTEGER NOT NULL DEFAULT 0,
  baseline_mae      REAL    NOT NULL DEFAULT 0.0,
  baseline_rmse     REAL    NOT NULL DEFAULT 0.0,
  baseline_wape     REAL    NOT NULL DEFAULT 0.0,
  ml_mae            REAL    NOT NULL DEFAULT 0.0,
  ml_rmse           REAL    NOT NULL DEFAULT 0.0,
  ml_wape           REAL    NOT NULL DEFAULT 0.0,
  improvement_pct   REAL    NOT NULL DEFAULT 0.0,
  status            TEXT    NOT NULL DEFAULT 'COMPLETED',
  details_json      TEXT    DEFAULT '{}',
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ml_training_runs_biz ON ml_training_runs(business_id, created_at);
