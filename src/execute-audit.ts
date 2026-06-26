/**
 * Maps a doer ExecutionResult to an append-only audit entry (PRD R7 — every
 * action logged with its outcome). Pure: no DB, no Meta. The orchestration layer
 * writes the returned entry through the AuditSink.
 */
import type { AuditEntry } from "./audit.js";
import type { ActionType, Decision } from "./guard.js";
import type { ExecutionResult } from "./doer.js";

export function executionAuditEntry(
  action: ActionType,
  decision: Decision,
  result: ExecutionResult,
  ts: string,
  actor = "agent"
): AuditEntry {
  const entityId =
    decision.allowed && typeof decision.effectiveArgs.entityId === "string"
      ? decision.effectiveArgs.entityId
      : null;
  const base = { ts, actor, action: String(action), entityId };

  if (!result.executed) {
    return { ...base, ruleTriggered: null, result: "not_executed", details: { reason: result.reason } };
  }
  if (result.verified) {
    return { ...base, ruleTriggered: null, result: "executed_verified", details: { wrote: result.wrote } };
  }
  return { ...base, ruleTriggered: "needs_reconcile", result: "executed_needs_reconcile", details: { wrote: result.wrote, reconcile: result.reconcile } };
}
