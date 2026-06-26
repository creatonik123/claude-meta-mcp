/**
 * The doer: takes an ALLOWED guard decision, performs the real Meta write, then
 * reads the entity back to confirm the change actually took. Execution is gated
 * behind an explicit flag (default off) so the code can be built and tested
 * without ever touching Meta. Never called for a refusal.
 */
import type { ActionType, Decision } from "./guard.js";

export interface MetaWriter {
  post(
    path: string,
    body: Record<string, string | number | boolean | undefined>
  ): Promise<unknown>;
}

export interface MetaReader {
  // Read the named fields of an entity back from Meta (to confirm a write took).
  get(entityId: string, fields: string[]): Promise<Record<string, unknown>>;
}

// Single-flight lock + idempotency. Meta has no native idempotency key and caps
// writes per hour (e.g. 4 ad-set budget changes/hr), so we serialise per entity
// and skip an action already applied in THIS run (a later run may re-apply the same
// value — that is intended, and safe because writes are absolute). DB-backed in production (wired at
// the next slice); injected here so the safety is enforced at the write.
export interface ExecutionCoordinator {
  acquire(lockKey: string): Promise<boolean>; // false if another write holds the lock
  release(lockKey: string): Promise<void>;
  alreadyApplied(dedupeKey: string): Promise<boolean>;
  markApplied(dedupeKey: string): Promise<void>;
}

export interface DoerDeps {
  executionEnabled: boolean;
  writer: MetaWriter;
  reader: MetaReader;
  coordinator: ExecutionCoordinator;
  // The managed account's currency offset (minor units per major unit) — e.g. 100
  // for AUD, 1 for zero-decimal currencies like JPY. Read from the account, never
  // assumed: guessing it would mis-budget by up to 100x.
  currencyOffset: number;
}

export type ExecutionResult =
  | { executed: false; reason: string }
  | { executed: true; verified: true; wrote: { path: string; body: Record<string, unknown> }; result: unknown }
  | { executed: true; verified: false; wrote: { path: string; body: Record<string, unknown> }; result: unknown; reconcile: string };

interface Translation {
  path: string;
  body: Record<string, string | number | boolean | undefined>;
  // What to read back to confirm the write took. `field` is the entity field to
  // re-read; `expected` is its expected value as a string (Meta returns scalars
  // as strings). For pause we check `status`, never `effective_status` — an ad
  // set can read back PAUSED with effective_status WITH_ISSUES (a separate
  // delivery concern), which is not a pause failure.
  verify: { entityId: string; field: string; expected: string };
}

// Translate an allowed action + its guard-approved effectiveArgs into the exact
// Meta Graph call plus the read-back check that confirms it.
function translate(
  action: ActionType,
  args: Record<string, unknown>,
  currencyOffset: number
): Translation {
  const entityId = String(args.entityId);
  if (action === "pause") {
    return { path: `/${entityId}`, body: { status: "PAUSED" }, verify: { entityId, field: "status", expected: "PAUSED" } };
  }
  if (action === "adjust_adset_budget") {
    // Meta wants the budget in minor units. The multiplier is the account's currency
    // offset (100 for AUD, 1 for zero-decimal currencies) — never assumed. A bad
    // offset would mis-budget badly, so refuse rather than guess.
    if (!Number.isInteger(currencyOffset) || currencyOffset <= 0) {
      throw new Error(`invalid currency offset '${currencyOffset}'`);
    }
    // Don't trust the value: a malformed dailyBudget (missing, NaN, string, <=0)
    // must refuse, never post a garbage budget. Symmetric with the offset guard.
    const raw = args.dailyBudget;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw new Error(`invalid dailyBudget '${String(raw)}'`);
    }
    const minorUnits = Math.round(raw * currencyOffset);
    return { path: `/${entityId}`, body: { daily_budget: minorUnits }, verify: { entityId, field: "daily_budget", expected: String(minorUnits) } };
  }
  if (action === "publish_approved_creative") {
    // The guard can allow publish, but publishing approved creative is handled by the
    // separate creative pipeline, not this write path. Refuse here (structured no-write,
    // audited) so an allowed publish never silently looks like a doer failure.
    throw new Error("publish_approved_creative is handled by the creative pipeline, not the doer");
  }
  throw new Error(`unsupported action '${action}'`);
}

export async function executeDecision(
  action: ActionType,
  decision: Decision,
  deps: DoerDeps
): Promise<ExecutionResult> {
  // Fail-safe: execution is off unless explicitly enabled. No write, ever, while off.
  if (!deps.executionEnabled) {
    return { executed: false, reason: "execution disabled (recommend-only) — no write performed" };
  }
  if (!decision.allowed) {
    return { executed: false, reason: "decision was refused by the guard — not executed" };
  }
  // A translation failure (unsupported action, bad offset, malformed budget) is a
  // structured no-write, never a thrown exception (PRD R3: blocked calls refuse).
  let call: Translation;
  try {
    call = translate(action, decision.effectiveArgs, deps.currencyOffset);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { executed: false, reason: `not executed (${msg})` };
  }

  const wrote = { path: call.path, body: call.body as Record<string, unknown> };
  // Per-entity single-flight lock; dedupe key is the exact write (so a different
  // value is not deduped, but the same one re-applied is skipped).
  const lockKey = call.verify.entityId;
  const dedupeKey = `${action}:${call.path}:${JSON.stringify(call.body)}`;

  // Acquire the lock. A failure to acquire (store error) fails closed — no write.
  let locked: boolean;
  try {
    locked = await deps.coordinator.acquire(lockKey);
  } catch (e) {
    return { executed: false, reason: `could not acquire write lock (fail-closed): ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!locked) {
    return { executed: false, reason: `another write is in progress for ${lockKey} — skipped` };
  }

  try {
    // Idempotency check inside the lock (check-and-act atomic).
    let applied: boolean;
    try {
      applied = await deps.coordinator.alreadyApplied(dedupeKey);
    } catch (e) {
      return { executed: false, reason: `idempotency check failed (fail-closed): ${e instanceof Error ? e.message : String(e)}` };
    }
    if (applied) {
      return { executed: false, reason: "already applied in this run — idempotent skip" };
    }

    // Attempt the write. Meta gives no write receipt, and a thrown POST is ambiguous
    // (it may have applied before the response failed). So we don't trust the write's
    // own outcome — the read-back below is the single source of truth.
    let result: unknown = null;
    let writeError: string | null = null;
    try {
      result = await deps.writer.post(call.path, call.body);
    } catch (e) {
      writeError = e instanceof Error ? e.message : String(e);
    }

    // Read the entity back and confirm the actual state.
    let readBack: Record<string, unknown>;
    try {
      readBack = await deps.reader.get(call.verify.entityId, [call.verify.field]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (writeError) {
        return { executed: true, verified: false, wrote, result, reconcile: `write errored and could not be verified — manual reconcile needed (write: ${writeError}; read-back: ${msg})` };
      }
      return { executed: true, verified: false, wrote, result, reconcile: `write sent but could not be verified (read-back failed: ${msg})` };
    }

    const actual = readBack?.[call.verify.field];
    if (String(actual) === call.verify.expected) {
      // The change is present — verified, regardless of whether the write call errored.
      // Record it so a repeat within this run dedupes (best-effort; the audit log is durable).
      try { await deps.coordinator.markApplied(dedupeKey); } catch { /* best-effort */ }
      return { executed: true, verified: true, wrote, result };
    }
    if (writeError) {
      // Write errored and the requested change is not present. We never read the
      // pre-write value, so we report only what we observed, not "unchanged".
      // Safe to retry regardless: the doer writes absolute values.
      return { executed: false, reason: `write call failed and the requested change is not present (read-back ${call.verify.field}='${String(actual)}') — safe to retry: ${writeError}` };
    }
    return {
      executed: true,
      verified: false,
      wrote,
      result,
      reconcile: `read-back ${call.verify.field}='${String(actual)}' did not match expected '${call.verify.expected}'`,
    };
  } finally {
    try { await deps.coordinator.release(lockKey); } catch { /* best-effort release */ }
  }
}
