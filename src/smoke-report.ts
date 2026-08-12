/**
 * Decision logic for the zero-spend smoke test — the first execution the write path will ever see.
 * Pure functions only; the IO shell is scripts/smoke-pause.mjs. Every judgement here fails closed:
 * a state that is not exactly the expected one is reported as such, never rounded up to a pass.
 */

// The complete gated write surface. Must match TOOL_TO_ACTION in execution-wiring.ts — a test
// there pins that mapping; this list exists so the smoke test can tell "off", "on", and the
// dangerous in-between apart.
export const WRITE_TOOLS = ["pause_entity", "adjust_adset_budget", "publish_approved_creative"] as const;

export interface SurfaceAssessment {
  inert: boolean;
  armed: boolean;
  writeToolsPresent: string[];
  summary: string;
}

export function assessSurface(toolNames: string[]): SurfaceAssessment {
  const present = WRITE_TOOLS.filter((t) => toolNames.includes(t));
  if (present.length === 0) {
    return {
      inert: true,
      armed: false,
      writeToolsPresent: [],
      summary:
        "INERT: no write tools registered. Next step is the switch-on (ADPILOT_EXECUTION_ENABLED=true in the guard's env, plus allowedCampaignIds and the pause actionMode) — a human's click, never this script's.",
    };
  }
  if (present.length < WRITE_TOOLS.length) {
    return {
      inert: false,
      armed: false,
      writeToolsPresent: present,
      summary: `PARTIAL write surface (${present.join(", ")}) — a half-registered deployment is an error state; do not smoke-test against it. Redeploy and re-check.`,
    };
  }
  return {
    inert: false,
    armed: true,
    writeToolsPresent: present,
    summary: "ARMED: all three write tools registered. The zero-spend pause smoke test can run.",
  };
}

/**
 * Map the guard's REAL tool payload to a status. Shape proven by the first live run
 * (2026-08-12): { decision: {allowed, code?}, execution: {executed, verified?, reason?} | null }.
 * The first version of the runner GUESSED an app-side shape and judged 'missing' — this mapping
 * is the corrected cross-boundary contract, pinned by tests.
 */
export function statusFromPayload(payload: {
  decision?: { allowed?: boolean; code?: string };
  execution?: { executed?: boolean; verified?: boolean; reason?: string } | null;
}): { status: string; reason?: string } {
  if (!payload.decision?.allowed) {
    return { status: "refused", reason: payload.decision?.code ?? "unknown_refusal" };
  }
  const ex = payload.execution;
  if (!ex || ex.executed !== true) {
    return { status: "not_executed", reason: ex?.reason ?? "no execution result" };
  }
  if (ex.verified === true) return { status: "executed_verified" };
  return { status: "executed_needs_reconcile" };
}

export interface SmokeRunInputs {
  pauseResult: { status?: string; reason?: string } | null;
  auditBefore: number | null;
  auditAfter: number | null;
}

export interface SmokeVerdict {
  pass: boolean;
  summary: string;
}

export function judgeSmokeRun({ pauseResult, auditBefore, auditAfter }: SmokeRunInputs): SmokeVerdict {
  const status = pauseResult?.status ?? "missing";
  if (status === "refused") {
    return {
      pass: false,
      summary: `NOT A PASS: the guard refused the pause (${pauseResult?.reason ?? "no reason given"}). The refusal itself worked, but the smoke test's write never happened.`,
    };
  }
  if (status !== "executed_verified") {
    return {
      pass: false,
      summary: `NOT A PASS: pause ended '${status}' — anything short of executed_verified (including needs_reconcile) means the write was not proven. Investigate before calling the path live.`,
    };
  }
  if (typeof auditBefore !== "number" || typeof auditAfter !== "number") {
    return {
      pass: false,
      summary: "NOT A PASS: the audit count was unreadable. A write without provable audit rows fails closed.",
    };
  }
  const delta = auditAfter - auditBefore;
  if (delta < 2) {
    return {
      pass: false,
      summary: `NOT A PASS: expected at least 2 new audit rows (guard decision + outcome), saw ${delta}. An unaudited write is worse than no write.`,
    };
  }
  return {
    pass: true,
    summary: `PASS: pause executed and verified, ${delta} new audit rows. The write path has now executed for the first time — at a cost of A$0.`,
  };
}
