/**
 * The doer: takes an ALLOWED guard decision, performs the real Meta write, then
 * reads the entity back to confirm the change actually took. Execution is gated
 * behind an explicit flag (default off) so the code can be built and tested
 * without ever touching Meta. Never called for a refusal.
 */
import type { ActionType, Decision } from "./guard.js";
import { executePublish } from "./doer-publish.js";
import type { AdPublisher } from "./doer-publish.js";

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

// Publish is a different write shape (create, not update) and lives in doer-publish.ts. Its deps are
// OPTIONAL so a deployment that does not publish stays exactly as it was: absent wiring produces a
// structured no-write, never a crash and never an improvised creation.
export interface PublishWiring {
  // The immutable record the guard checked. Re-read HERE, immediately before the write: the guard
  // decided at time T and the write happens at T+n, and in between another run can consume the
  // approval. This is also the ONLY source of the destination — the guard passes just the hash, so no
  // caller-supplied id can influence where the creative lands.
  approvalByHash(hash: string): Promise<{ consumed: boolean; targetEntityId?: string | null } | null>;
  publisher: AdPublisher;
  consumeApproval(bindingHash: string, publishedRef: string): Promise<{ consumed: boolean }>;
}

export interface DoerDeps {
  executionEnabled: boolean;
  writer: MetaWriter;
  reader: MetaReader;
  coordinator: ExecutionCoordinator;
  publish?: PublishWiring;
  // The managed account's currency offset (minor units per major unit) — e.g. 100
  // for AUD, 1 for zero-decimal currencies like JPY. Read from the account, never
  // assumed: guessing it would mis-budget by up to 100x.
  currencyOffset: number;
  // REHEARSE the write instead of performing it: the full guard decision runs, the real body is
  // built and sent to Meta with `execution_options=["validate_only"]`, and Meta validates it without
  // changing anything. Absent/false = a normal write, byte-for-byte unchanged.
  //
  // The flag can only make the system do LESS, so a mistake in either direction is safe: set when a
  // write was intended, nothing happens; unset when a rehearsal was intended, the existing approval
  // and guard checks still gate the write exactly as before.
  validateOnly?: boolean;
}

export type ExecutionResult =
  | { executed: false; reason: string }
  | { executed: false; reason: string; dryRun: true; validated: boolean; wrote: { path: string; body: Record<string, unknown> } }
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
  if (action === "activate") {
    // The mirror of pause, verified on `status` for the same reason pause is.
    return { path: `/${entityId}`, body: { status: "ACTIVE" }, verify: { entityId, field: "status", expected: "ACTIVE" } };
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
    // Publish does NOT go through translate(), and that is a design decision rather than an omission.
    // This function models an idempotent absolute update on an entity that already exists, verified by
    // re-reading one field. Creating an ad has no prior entity id, is not idempotent, and is verified by
    // re-SEARCHING for a keyed name — so it lives in doer-publish.ts `executePublish`, which owns the
    // per-approval lock, search-before-create and verify-after-create.
    //
    // Reaching HERE means a publish was routed down the update path by mistake. Refuse (structured
    // no-write, audited) rather than improvise: an improvised creation cannot be un-sent.
    throw new Error("publish_approved_creative is executed by doer-publish.ts (executePublish), not translate()");
  }
  throw new Error(`unsupported action '${action}'`);
}

// Meta's own request validator: it checks the request exactly as a real one and returns success
// WITHOUT applying it. Form-encoded, so the value is the JSON array as a string.
//
// Built HERE, from the translation, rather than accepted from a caller: a dry run whose flag could
// be dropped anywhere on the way to Meta would be a real write wearing a rehearsal's label.
const VALIDATE_ONLY = '["validate_only"]';
function validateOnlyBody(body: Record<string, string | number | boolean | undefined>) {
  return { ...body, execution_options: VALIDATE_ONLY };
}

/**
 * Resolve the publish destination from the approval record, then run the create path.
 *
 * Every branch here refuses rather than guesses, because the thing being decided is whether to make a
 * write that cannot be un-sent:
 *   - wiring absent        -> a half-configured deployment must not improvise a creation
 *   - approval unreadable  -> not knowing whether an approval is spent is not permission
 *   - approval missing     -> nothing was signed
 *   - approval consumed    -> it was already spent, possibly seconds ago by another run
 *   - no target recorded   -> the destination is unprovable; the guard refuses these too
 */
async function runPublish(decision: Decision, deps: DoerDeps): Promise<ExecutionResult> {
  const wiring = deps.publish;
  if (!wiring || typeof wiring.approvalByHash !== "function") {
    return { executed: false, reason: "publish is not wired on this deployment — no ad created (fail-closed)" };
  }
  const args = (decision as { effectiveArgs: Record<string, unknown> }).effectiveArgs || {};
  const hash = typeof args.approvalHash === "string" ? args.approvalHash.trim() : "";

  let approval: { consumed: boolean; targetEntityId?: string | null } | null;
  try {
    approval = await wiring.approvalByHash(hash);
  } catch (e) {
    return { executed: false, reason: `approval unreadable (fail-closed): ${e instanceof Error ? e.message : String(e)}` };
  }
  if (approval === null) {
    return { executed: false, reason: "no approval record matches this hash — not executed" };
  }
  if (approval.consumed !== false) {
    return { executed: false, reason: "approval is already consumed (or its state is unknown) — not executed" };
  }
  const target = typeof approval.targetEntityId === "string" ? approval.targetEntityId.trim() : "";
  if (target === "") {
    return { executed: false, reason: "approval record carries no target ad set — publish destination unprovable" };
  }

  // The COMPANION rendering, when the guard let one through. The destination is still `target`, read
  // from the PRIMARY approval record — a companion names a second approved image and never a target.
  const companionHash = typeof args.companionHash === "string" ? args.companionHash.trim() : "";

  const r = await executePublish(
    { approvalHash: hash, targetEntityId: target, ...(companionHash ? { companionHash } : {}) },
    {
      executionEnabled: deps.executionEnabled,
      coordinator: deps.coordinator,
      publisher: wiring.publisher,
      consumeApproval: wiring.consumeApproval,
      // Freshness of the COMPANION only, through the same reader that already answered for the
      // primary above. A spent companion means that image is already live in another ad. Anything
      // unreadable counts as spent, so the companion is dropped rather than risked.
      isApprovalConsumed: async (h: string) => {
        const a = await wiring.approvalByHash(h);
        return !a || a.consumed !== false;
      },
    }
  );

  // Map the publish outcome onto the doer's shared result shape. `wrote` describes the creation for the
  // audit row; there is no field read-back for a create, so `verified` comes from the search-after-create.
  if (r.executed === false) return { executed: false, reason: r.reason };
  if (r.verified === true) {
    const wrote = { path: `/${target}/ads`, body: { name: r.adName, approvalHash: hash } as Record<string, unknown> };
    return { executed: true, verified: true, wrote, result: { adId: r.adId, ...(r.consumeFailed ? { consumeFailed: true } : {}) } };
  }
  // Unverified: the ad NAME may be unknown (the create may not have got that far), so the audit row
  // records the destination and the approval rather than inventing a name.
  const wrote = { path: `/${target}/ads`, body: { approvalHash: hash } as Record<string, unknown> };
  return { executed: true, verified: false, wrote, result: { adId: r.adId ?? null }, reconcile: r.reconcile };
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

  // PUBLISH takes the create path, never translate(). Routed before translate() is even attempted, so a
  // publish can never be mistaken for an update.
  if (action === "publish_approved_creative") {
    return await runPublish(decision, deps);
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

  // REHEARSAL. Deliberately placed BEFORE the lock and the idempotency check: a dry run changes
  // nothing, so it must not serialize a real write behind it, must not consume the dedupe key that a
  // subsequent real write depends on, and must not mark anything applied. It also never reads back —
  // there is nothing to verify — and returns executed:false, so executionAuditEntry records it as
  // `not_executed`, a status the app never counts as a possible write.
  if (deps.validateOnly === true) {
    const body = validateOnlyBody(call.body);
    try {
      const result = await deps.writer.post(call.path, body);
      return {
        executed: false,
        dryRun: true,
        validated: true,
        wrote: { path: call.path, body },
        reason: `dry run: Meta validated this write without applying it (${JSON.stringify(result)})`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        executed: false,
        dryRun: true,
        validated: false,
        wrote: { path: call.path, body },
        reason: `dry run: Meta REJECTED this write (nothing was applied): ${msg}`,
      };
    }
  }

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
