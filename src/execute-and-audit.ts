/**
 * Orchestration: after the guard ALLOWS a decision (already audited upstream),
 * this executes it — only when execution is enabled — and writes the execution
 * outcome to the audit log (PRD R7). Returns null when there is nothing to execute
 * (refused, or recommend-only). Nothing here decides or clamps.
 *
 * R7 durability: the Meta write happens BEFORE the audit write, and the write
 * cannot be un-sent. So if the audit write fails, we must never (a) lose the fact
 * silently or (b) crash the caller. We surface `audited:false` for reconcile and
 * emit a last-resort log, so an executed action is never invisible.
 */
import { executeDecision, type DoerDeps, type ExecutionResult } from "./doer.js";
import { executionAuditEntry } from "./execute-audit.js";
import type { ActionType, Decision } from "./guard.js";
import type { AuditSink } from "./audit.js";

export interface ExecuteOutcome {
  execution: ExecutionResult;
  audited: boolean; // false => the action ran but its audit row could not be written
  auditError?: string;
}

export async function executeAndAudit(
  action: ActionType,
  decision: Decision,
  deps: DoerDeps,
  audit: AuditSink,
  now: () => Date,
  actor = "agent"
): Promise<ExecuteOutcome | null> {
  // Nothing to execute: a refusal, or recommend-only (execution off). The decision
  // itself was already audited upstream, so we add no execution row.
  if (!decision.allowed || !deps.executionEnabled) {
    return null;
  }

  const execution = await executeDecision(action, decision, deps);
  const entry = executionAuditEntry(action, decision, execution, now().toISOString(), actor);

  try {
    await audit.write(entry);
  } catch (e) {
    const auditError = e instanceof Error ? e.message : String(e);
    // The action already happened and cannot be un-sent. Don't lose it, don't crash:
    // a last-resort trace keeps the record alive even if the audit store is down, and
    // audited:false tells the caller to reconcile.
    console.error("AUDIT WRITE FAILED for an executed action:", JSON.stringify(entry), "-", auditError);
    return { execution, audited: false, auditError };
  }

  return { execution, audited: true };
}
