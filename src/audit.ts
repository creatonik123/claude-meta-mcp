/**
 * Append-only audit entry (PRD R7). Every guarded decision — allow or
 * refuse — writes one of these. The real sink is a Postgres adapter (the
 * shared audit_log table); tests inject a fake that records in memory.
 * Nothing here touches Meta.
 */
export interface AuditEntry {
  ts: string; // ISO timestamp
  actor: string; // "agent" or "human:<id>"
  action: string; // the action type attempted
  entityId: string | null;
  ruleTriggered: string | null; // refusal code, or null when allowed
  result: "approved_for_execution" | "refused";
  details: Record<string, unknown>;
}

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}
