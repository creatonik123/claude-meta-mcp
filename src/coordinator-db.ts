/**
 * DB-backed ExecutionCoordinator (PRD §6a — coordination lives with the guarded
 * write path). The atomic lease-lock + dedupe live in Postgres (migration
 * 0001_execution_coordinator.sql); this adapter just issues the queries and
 * interprets the result. `sql` is injected so the real Neon client is created
 * only at the wiring edge, never imported here.
 */
import type { ExecutionCoordinator } from "./doer.js";

export type Sql = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

// LEASE INVARIANT: ttlSeconds MUST exceed the doer's worst-case critical section —
// it holds this lock across the Meta write AND the read-back. With the Meta client's
// 30s per-call timeout and no adapter-level retries, that worst case is ~60s, so the
// 120s default leaves ~2x margin. If write retries/backoff are ever added, raise the
// TTL accordingly (or add lease renewal / pre-write ownership re-check) — otherwise a
// lease could expire mid-write and a second run could take the lock. Harmless while
// execution is off; tighten before enabling live concurrent writes.
export function createDbCoordinator(sql: Sql, holder: string, ttlSeconds = 120): ExecutionCoordinator {
  return {
    // Atomic take-or-fail: insert the lock, or take it over only if the existing
    // lease has expired. Returns our holder iff we now hold it.
    async acquire(lockKey) {
      const rows = await sql(
        `INSERT INTO execution_locks (lock_key, holder, expires_at)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
         ON CONFLICT (lock_key) DO UPDATE
           SET holder = EXCLUDED.holder, acquired_at = now(), expires_at = EXCLUDED.expires_at
           WHERE execution_locks.expires_at < now()
         RETURNING holder`,
        [lockKey, holder, ttlSeconds]
      );
      return rows.length > 0 && rows[0].holder === holder;
    },

    // Release only our own lock — never another run's.
    async release(lockKey) {
      await sql(`DELETE FROM execution_locks WHERE lock_key = $1 AND holder = $2`, [lockKey, holder]);
    },

    // Dedupe is scoped to THIS run (holder): single-flight within a run, but a
    // later run is free to re-apply the same value (re-pause, re-set a drifted
    // budget). Safe because the doer writes absolute values, not deltas.
    async alreadyApplied(dedupeKey) {
      const rows = await sql(
        `SELECT 1 FROM execution_applied WHERE dedupe_key = $1 AND holder = $2`,
        [dedupeKey, holder]
      );
      return rows.length > 0;
    },

    async markApplied(dedupeKey) {
      await sql(
        `INSERT INTO execution_applied (dedupe_key, holder) VALUES ($1, $2)
         ON CONFLICT (dedupe_key, holder) DO NOTHING`,
        [dedupeKey, holder]
      );
    },
  };
}
