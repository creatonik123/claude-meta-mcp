-- Execution coordination for the doer (single Neon Postgres, shared with the orchestrator).
-- Two concerns, both idempotent to apply (safe to re-run):
--   1. A single-flight lock so two overlapping runs cannot write the same entity at once.
--      It carries a lease (expires_at) so a crashed run that never released does NOT
--      deadlock the entity forever — a later run can take an expired lock.
--   2. A per-RUN idempotency record so the same write is not re-sent twice within a
--      single run (Meta caps ad-set budget changes at 4/hour). It is scoped by holder
--      (the run id) ON PURPOSE: a LATER run must be free to re-apply the same value —
--      e.g. re-pause an ad a human re-activated, or re-set a budget that drifted back.
--      (Re-applying is safe anyway: the doer writes absolute values, not deltas.)
--      Old rows are pruned by a periodic cleanup; they are never matched by a new run.

CREATE TABLE IF NOT EXISTS execution_locks (
  lock_key    text PRIMARY KEY,
  holder      text        NOT NULL,        -- per-run id that holds the lock
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL         -- lease: an expired lock may be taken over
);

CREATE TABLE IF NOT EXISTS execution_applied (
  dedupe_key text        NOT NULL,         -- action + path + body (the exact write)
  holder     text        NOT NULL,         -- the run that applied it; dedupe is scoped to this
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dedupe_key, holder)         -- (key, run) — a new run is never deduped against an old one
);
