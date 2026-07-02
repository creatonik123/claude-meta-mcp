/**
 * Real Postgres AuditSink over the shared audit_log table (PRD R7), via an
 * injected `sql`. The row timestamp is the DB's own now() — a broken caller
 * clock must not poison the insert — while the decision-time ts is preserved
 * inside the jsonb details. A failed write THROWS: upstream, runGuardedDecision
 * downgrades an unlogged allow to a refusal (never an unlogged allow), and
 * executeAndAudit surfaces audited:false for an already-performed write.
 */
import type { AuditEntry, AuditSink } from "./audit.js";
import type { Sql } from "./coordinator-db.js";

export function createDbAuditSink(sql: Sql): AuditSink {
  return {
    async write(entry: AuditEntry): Promise<void> {
      await sql(
        `INSERT INTO audit_log (actor, action, entity_id, rule_triggered, result, metrics_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          entry.actor,
          entry.action,
          entry.entityId,
          entry.ruleTriggered,
          entry.result,
          JSON.stringify({ ts: entry.ts, ...entry.details }),
        ]
      );
    },
  };
}
