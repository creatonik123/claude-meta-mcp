/**
 * DB reads for the guard (GuardDb), over an injected `sql` (real Neon client wired
 * at the edge — not imported here). READS ONLY.
 *
 * Only killSwitchRow is wired today: `kill_switch(id, active)` exists and is the key
 * safety primitive. The other reads are deliberately FAIL-CLOSED (throw) — the guard's
 * failClosed wrapper turns a throw into a refusal, so a write is refused rather than
 * decided on data we can't yet read. They are blocked on, and must be built with:
 *   - approvalByHash: `approval_records` has no `consumed` column — the one-time-use
 *     model needs reconciling with the GuardDb interface (publish path, separate).
 *   - schemaVersion: no numeric schema-version source exists (only text schema_migrations).
 *   - startOfDayBudget / accountStartOfDayTotal / budgetBaseline30d: need the deferred
 *     midnight start-of-day snapshot job + its table.
 */
import type { GuardDb } from "./guard.js";
import type { Sql } from "./coordinator-db.js";

const BLOCKED = (what: string, why: string) => {
  throw new Error(`guard-db: ${what} not wired (${why}) — fail-closed`);
};

export function createGuardDb(sql: Sql): GuardDb {
  return {
    async killSwitchRow() {
      const rows = await sql(`SELECT active FROM kill_switch WHERE id = 1`, []);
      if (rows.length === 0) return null; // missing -> guard treats as frozen
      const a = rows[0].active;
      return typeof a === "boolean" ? a : null;
    },
    async schemaVersion() {
      return BLOCKED("schemaVersion", "no numeric schema-version source yet");
    },
    async approvalByHash() {
      return BLOCKED("approvalByHash", "approval_records has no consumed column; publish path deferred");
    },
    async startOfDayBudget() {
      return BLOCKED("startOfDayBudget", "needs the start-of-day snapshot job");
    },
    async accountStartOfDayTotal() {
      return BLOCKED("accountStartOfDayTotal", "needs the start-of-day snapshot job");
    },
    async budgetBaseline30d() {
      return BLOCKED("budgetBaseline30d", "needs the start-of-day snapshot job");
    },
  };
}
