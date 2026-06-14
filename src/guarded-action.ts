/**
 * Runs an action through the guard, logs the decision, returns it (PRD R3 + R7).
 * Never writes to Meta itself. If the decision can't be logged, it's downgraded
 * to a refusal, so we never have an unlogged allow.
 */
import { evaluate, type ActionType, type Decision, type GuardDeps } from "./guard.js";
import type { AuditSink } from "./audit.js";

export async function runGuardedDecision(
  action: ActionType,
  args: Record<string, unknown>,
  deps: GuardDeps,
  audit: AuditSink,
  actor = "agent"
): Promise<Decision> {
  const decision = await evaluate(action, args, deps); // never throws (wrapped)

  // Extract entityId defensively — args may be null/non-object at runtime.
  let entityId: string | null = null;
  if (args && typeof args === "object") {
    const v = (args as Record<string, unknown>).entityId;
    if (typeof v === "string") entityId = v;
  }

  // A broken clock must not take down the audit path.
  let ts: string;
  try {
    ts = deps.now().toISOString();
  } catch {
    ts = "unknown";
  }

  try {
    await audit.write({
      ts,
      actor,
      action: String(action),
      entityId,
      ruleTriggered: decision.allowed ? null : decision.code,
      result: decision.allowed ? "approved_for_execution" : "refused",
      details: decision.allowed ? { effectiveArgs: decision.effectiveArgs } : { reason: decision.reason },
    });
  } catch (e) {
    // couldn't log it -> refuse (never return an unlogged allow)
    const msg = e instanceof Error ? e.message : String(e);
    const orig = decision.allowed ? "allow" : decision.code;
    return { allowed: false, code: "audit_write_failed", reason: `decision (orig: ${orig}) not durably logged — refused (fail-closed): ${msg}` };
  }

  return decision;
}
