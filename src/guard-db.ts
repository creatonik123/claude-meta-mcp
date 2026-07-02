/**
 * DB reads for the guard (GuardDb), over an injected `sql` (real Neon client wired
 * at the edge — not imported here). READS ONLY.
 *
 * killSwitchRow + schemaVersion + the three budget reads are backed by real tables
 * (kill_switch, guard_schema_version, execution_budget_snapshots — see migrations
 * 0001/0002). A non-finite/malformed value returns null, which the guard treats
 * fail-safe: null schema/start-of-day/account-total => refuse; null 30d-baseline =>
 * skip only the creep check (per the guard's documented contract).
 *
 * approvalByHash stays FAIL-CLOSED (throws): approval_records has no `consumed`
 * column yet, so the one-time-use publish model is unbuilt. The guard's failClosed
 * wrapper turns the throw into a refusal, so a publish is refused, never guessed.
 */
import type { GuardDb } from "./guard.js";
import type { Sql } from "./coordinator-db.js";

const BLOCKED = (what: string, why: string): never => {
  throw new Error(`guard-db: ${what} not wired (${why}) — fail-closed`);
};

// PG NUMERIC / SUM / AVG can arrive as a string; coerce and reject non-finite.
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
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
      const rows = await sql(`SELECT version FROM guard_schema_version WHERE id = 1`, []);
      if (rows.length === 0) return null;
      const v = num(rows[0].version);
      return v != null && Number.isInteger(v) ? v : null;
    },
    async approvalByHash() {
      return BLOCKED("approvalByHash", "approval_records has no consumed column; publish path deferred");
    },
    async startOfDayBudget(entityId: string, day: string) {
      const rows = await sql(
        `SELECT daily_budget FROM execution_budget_snapshots WHERE entity_id = $1 AND day = $2`,
        [entityId, day]
      );
      if (rows.length === 0) return null;
      return num(rows[0].daily_budget);
    },
    async accountStartOfDayTotal(day: string) {
      // SUM over an empty set returns one row with NULL -> num(null) -> null (fail-safe).
      const rows = await sql(
        `SELECT SUM(daily_budget) AS total FROM execution_budget_snapshots WHERE day = $1`,
        [day]
      );
      if (rows.length === 0) return null;
      return num(rows[0].total);
    },
    async budgetBaseline30d(entityId: string, day: string) {
      // Trailing 30 days STRICTLY BEFORE the anchor day, anchored to the
      // guard's account-tz day (never the DB server's CURRENT_DATE, which is
      // UTC on Neon). Excluding the anchor day matters: today's own snapshot
      // is exactly the value being clamped, and folding it into the baseline
      // would raise the 2x creep ceiling on the very trajectory it exists to
      // stop.
      const rows = await sql(
        `SELECT AVG(daily_budget) AS avg FROM execution_budget_snapshots
         WHERE entity_id = $1 AND day < $2::date AND day >= ($2::date - INTERVAL '30 days')`,
        [entityId, day]
      );
      if (rows.length === 0) return null;
      return num(rows[0].avg);
    },
  };
}
