/**
 * The publish write path — the ONE non-idempotent write in AdPilot.
 *
 * Deliberately separate from `doer.ts`'s `translate()` flow. That flow models an idempotent absolute
 * update (pause, set-budget) on an entity that already exists, verified by re-reading one field.
 * Publishing is a different shape: it searches first, creates a NEW object with no prior id, and
 * verifies by RE-SEARCHING for a keyed name. Forcing it into the same mould would have meant either
 * weakening the read-back check or pretending a creation is an update.
 *
 * THREE LAYERS OF PROTECTION, each covering what the others cannot:
 *   1. A per-APPROVAL lock. Search-before-create has a race window — two runs searching concurrently
 *      would both see nothing and both create. The lock closes it. Keyed on the binding hash rather
 *      than the ad set, because the approval is the thing whose duplication costs money, and two
 *      different approvals landing in one ad set do not conflict (different names).
 *   2. Search-before-create. The durable check: Meta itself holds the record, so this survives a crash
 *      on our side at any instant — including immediately after the create call returned.
 *   3. Verify-after-create. Proves exactly one keyed ad exists and that it is the one Meta named.
 *
 * The approval is consumed ONLY after verification. An unverified create leaves it OPEN on purpose: the
 * keyed name means the next run finds the ad and ADOPTS it, which is safe. Re-creating is not.
 *
 * No Meta specifics live here. `publisher` is injected: assembling the creative (copy from the
 * approval's composition, the uploaded image) belongs behind that port, so this file can be tested
 * without a network and reasoned about as pure control flow.
 */
import { decidePublish, verifyAfterCreate } from "./publish-plan.js";
import type { AdRow } from "./publish-plan.js";
import type { ExecutionCoordinator } from "./doer.js";

export interface AdPublisher {
  // The ads in ONE ad set, for the search-before/after-create checks.
  searchAdsInAdset(args: { adsetId: string; adName: string }): Promise<AdRow[]>;
  // Create exactly one ad under EXACTLY the given name. The name carries the approval's binding hash
  // and IS the idempotency key, so an implementation must never alter, prefix or truncate it.
  createAd(args: { adsetId: string; name: string; approvalHash: string }): Promise<{ id: string }>;
}

export interface PublishDeps {
  executionEnabled: boolean;
  coordinator: ExecutionCoordinator;
  publisher: AdPublisher;
  // Records that this approval is spent and which ad it produced. One append (app migration 0011).
  consumeApproval(bindingHash: string, publishedRef: string): Promise<{ consumed: boolean }>;
}

export type PublishExecution =
  | { executed: false; reason: string; adopted?: true; adId?: string; verified?: undefined; reconcile?: undefined; consumeFailed?: undefined }
  | { executed: true; verified: true; adId: string; adName: string; consumeFailed?: true; reason?: undefined; reconcile?: undefined }
  | { executed: true; verified: false; reconcile: string; adId?: string; reason?: undefined; consumeFailed?: undefined };

// Meta's created-ad id. Anything that is not a non-empty string is an answer we cannot act on — and
// must not be treated as success, because we would then consume an approval with no proof of an ad.
function createdId(res: unknown): string | null {
  if (!res || typeof res !== "object" || Array.isArray(res)) return null;
  const id = (res as { id?: unknown }).id;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

export async function executePublish(
  { approvalHash, targetEntityId }: { approvalHash: string; targetEntityId: string },
  deps: PublishDeps
): Promise<PublishExecution> {
  // Fail-safe: off unless explicitly enabled. An off switch must not even LOOK at Meta.
  if (!deps.executionEnabled) {
    return { executed: false, reason: "execution disabled (recommend-only) — no ad created" };
  }
  // A half-configured deployment must degrade to a structured no-write, never a thrown exception.
  if (!deps.publisher || typeof deps.publisher.createAd !== "function" || typeof deps.publisher.searchAdsInAdset !== "function") {
    return { executed: false, reason: "publisher not wired — no ad created (fail-closed)" };
  }

  const hash = typeof approvalHash === "string" ? approvalHash.trim() : "";
  const adsetId = typeof targetEntityId === "string" ? targetEntityId.trim() : "";
  // decidePublish re-checks both, but doing it here keeps the lock out of the picture entirely for an
  // input we already know is unusable.
  if (!/^[0-9a-f]{64}$/.test(hash) || adsetId === "") {
    return { executed: false, reason: "unusable approval hash or target ad set — no ad created" };
  }

  // The lock is on the APPROVAL. Two concurrent runs holding the same approval is the only way
  // search-before-create can be defeated.
  const lockKey = `publish:${hash}`;
  let locked: boolean;
  try {
    locked = await deps.coordinator.acquire(lockKey);
  } catch (e) {
    return { executed: false, reason: `could not acquire publish lock (fail-closed): ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!locked) {
    return { executed: false, reason: `another publish is in progress for this approval — skipped` };
  }

  try {
    // 1. SEARCH BEFORE CREATE. Anything ambiguous refuses without creating.
    const plan = await decidePublish({ bindingHash: hash, adsetId }, { searchAdsInAdset: deps.publisher.searchAdsInAdset });

    if (plan.decision === "already_published") {
      // Crash recovery: Meta already holds our ad. Settle the approval so it stops being re-offered.
      // Best-effort — the ad demonstrably exists, so a bookkeeping failure is not a publish failure.
      let consumeFailed = false;
      try { await deps.consumeApproval(hash, plan.adId!); } catch { consumeFailed = true; }
      return { executed: false, reason: consumeFailed ? "already_published_unconsumed" : "already_published", adopted: true, adId: plan.adId };
    }
    if (plan.decision !== "create") {
      return { executed: false, reason: plan.reason! };
    }

    // 2. THE CREATE. Exactly one attempt. No retry at any layer (MONEY_RULES A1): retrying is precisely
    //    how one approval becomes two live ads.
    let res: unknown = null;
    let createError: string | null = null;
    try {
      res = await deps.publisher.createAd({ adsetId: plan.adsetId!, name: plan.adName!, approvalHash: hash });
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
    }

    const adId = createdId(res);
    if (createError !== null || adId === null) {
      // Meta may or may not have created it. We do not know and must not guess. The approval stays
      // OPEN; the next run's search finds the ad by its keyed name if it exists.
      return {
        executed: true,
        verified: false,
        reconcile: createError !== null
          ? `create outcome unknown — one attempt was made and it errored, so an ad may exist (${createError})`
          : "create returned no usable ad id — an ad may exist; not consumed",
      };
    }

    // 3. VERIFY AFTER CREATE. Prove exactly one keyed ad exists and that it is the one Meta named.
    const v = await verifyAfterCreate({ bindingHash: hash, adsetId, adId }, { searchAdsInAdset: deps.publisher.searchAdsInAdset });
    if (!v.ok) {
      // The ad may well be live. It is NOT consumed, so the next run resolves it through the key.
      // What must never happen is reporting success, or creating another.
      return { executed: true, verified: false, adId, reconcile: `created but unverified (${v.reason})${v.adIds ? ` [${v.adIds.join(", ")}]` : ""}` };
    }

    // 4. Only now is the work durable and known. Consuming and recording which ad it produced are ONE
    //    append, so there is no window where the reference exists but the approval looks unused.
    let consumeFailed = false;
    try { await deps.consumeApproval(hash, adId); } catch { consumeFailed = true; }
    return { executed: true, verified: true, adId, adName: v.adName!, ...(consumeFailed ? { consumeFailed: true as const } : {}) };
  } finally {
    // Always release: a stuck lock would block this approval forever, and the next run is the very
    // mechanism that recovers an unverified create.
    try { await deps.coordinator.release(lockKey); } catch { /* best-effort */ }
  }
}
