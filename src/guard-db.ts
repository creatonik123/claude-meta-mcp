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
    // The human's signature, and whether it has already been spent.
    //
    // Consumption is NOT a column on approval_records: that table carries an append-only trigger
    // refusing every UPDATE, so its `consumed` column could never actually be written. The fact lives
    // in approval_consumptions instead (app migration 0011), one row per spent approval, which is why
    // this reads both tables in one statement.
    //
    // THE ASYMMETRY THAT DICTATES THE ERROR HANDLING: `consumed: false` is the ONLY value that lets a
    // publish proceed. So anything we cannot read with certainty THROWS (the guard turns that into a
    // fail-closed refusal) rather than defaulting — a driver quirk must never make a spent approval
    // look fresh and authorise a second live ad.
    async approvalByHash(hash: string) {
      const h = typeof hash === "string" ? hash.trim() : "";
      // Validate before querying: the hash is a binding fingerprint, always lowercase 64-hex.
      if (!/^[0-9a-f]{64}$/.test(h)) {
        throw new Error("guard-db: approvalByHash needs a lowercase 64-hex binding hash");
      }
      const rows = await sql(
        `SELECT ar.target_entity_id AS target,
                (SELECT count(*) FROM approval_consumptions ac WHERE ac.binding_hash = ar.binding_hash) AS consumed_count
           FROM approval_records ar
          WHERE ar.binding_hash = $1`,
        [h]
      );
      if (rows.length === 0) return null; // no signature -> guard refuses approval_missing
      const r = rows[0];
      // count() legitimately arrives as a string on some drivers, so coerce — but reject anything that
      // is not a whole, non-negative number. Unreadable => throw, never "unconsumed".
      const raw = r.consumed_count;
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        throw new Error(`guard-db: unreadable consumption count for approval (got ${JSON.stringify(raw)})`);
      }
      // Never coerced to a string: the guard compares the target as a trimmed string against the
      // campaign allowlist, so a number that stringifies differently would miss it silently.
      const target = typeof r.target === "string" && r.target.trim() !== "" ? r.target.trim() : null;
      return { consumed: n > 0, targetEntityId: target };
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
