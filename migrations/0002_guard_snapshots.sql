-- Guard read tables (single Neon Postgres, shared with the orchestrator). Idempotent.
--   1. execution_budget_snapshots: the FROZEN start-of-day daily budget per ad set, per
--      account-tz day. The write-guard reads these to enforce the per-entity clamp, the
--      account-aggregate cap (SUM over the day), and the 30-day creep ceiling (AVG). A
--      separate midnight job populates one row per active ad set each day.
--   2. guard_schema_version: a single numeric version the guard checks against its config.
--      A mismatch (or missing) makes the guard refuse writes (fail-closed) until reconciled.

CREATE TABLE IF NOT EXISTS execution_budget_snapshots (
  entity_id    text        NOT NULL,       -- ad set id
  day          date        NOT NULL,       -- account-tz calendar day (YYYY-MM-DD)
  daily_budget numeric     NOT NULL,       -- ad set daily budget at start of day (major units, e.g. AUD)
  captured_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, day)             -- one frozen snapshot per entity per day
);

CREATE INDEX IF NOT EXISTS idx_budget_snapshots_day ON execution_budget_snapshots (day);

CREATE TABLE IF NOT EXISTS guard_schema_version (
  id      integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- single row
  version integer NOT NULL
);

INSERT INTO guard_schema_version (id, version) VALUES (1, 1)
  ON CONFLICT (id) DO NOTHING;
