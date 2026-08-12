/**
 * Search-before-create / search-after-create for the one non-idempotent write — guard-side.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: AdPilot may only create an ad when it can SEE that the ad is
 * not already there. Every other outcome — an unreadable search, two ads carrying the same key, a match
 * in an ad set nobody approved, a key it cannot trust — resolves to doing nothing. Publishing one ad too
 * few is a message in Slack; publishing one too many is spend that cannot be un-sent, and Meta gives no
 * idempotency key for ad creation to fall back on.
 *
 * `searchAdsInAdset` is INJECTED and must return an array of `{ id, name, adset_id }` for the ads in ONE
 * ad set. This module performs no network I/O, never retries (MONEY_RULES A1), and never creates
 * anything itself — it only returns a decision for the caller to act on.
 *
 * Ported from app/lib/creative/publish-plan.js. Both implementations must behave identically; the shared
 * ad-name key is pinned by app/lib/creative/publish-name-vectors.json.
 */
import { buildAdName, bindingHashFromAdName, BINDING_HASH_RE } from "./publish-naming.js";

export interface AdRow {
  id: string;
  name: string;
  adset_id: string;
}

export type SearchAdsInAdset = (args: { adsetId: string; adName: string }) => Promise<AdRow[]>;

export type PublishDecision =
  | { decision: "create"; adName: string; adsetId: string; bindingHash: string; reason?: undefined; adId?: undefined; adIds?: undefined }
  | { decision: "already_published"; adId: string; adName: string; adsetId: string; reason?: undefined; adIds?: undefined }
  | { decision: "refuse"; reason: string; adId?: string; adIds?: string[]; adName?: undefined; adsetId?: undefined };

export type VerifyResult =
  | { ok: true; created: true; adId: string; adName: string; reason?: undefined; adIds?: undefined }
  | { ok: false; created: true; reason: string; adIds?: string[]; adId?: undefined; adName?: undefined };

const refuse = (reason: string, extra: Record<string, unknown> = {}): PublishDecision =>
  ({ decision: "refuse", reason, ...extra }) as PublishDecision;

function usableHash(bindingHash: unknown): bindingHash is string {
  return typeof bindingHash === "string" && BINDING_HASH_RE.test(bindingHash);
}

function usableAdsetId(adsetId: unknown): adsetId is string {
  return typeof adsetId === "string" && adsetId.trim() !== "";
}

// The ads in this ad set that carry THIS approval's key. A name we did not write reads back as null and
// is ignored, so a human's ad is never mistaken for our own work.
export function keyedMatches(rows: AdRow[], bindingHash: string): AdRow[] {
  return rows.filter((r) => r && bindingHashFromAdName(r.name) === bindingHash);
}

// One search, no retry. Returns rows or a failure — a thrown search and an empty ad set must never look
// alike, because one means "we don't know" and the other means "safe to create".
async function searchOnce(
  searchAdsInAdset: SearchAdsInAdset,
  args: { adsetId: string; adName: string }
): Promise<{ failed: true; rows?: undefined } | { failed?: undefined; rows: AdRow[] }> {
  try {
    const rows = await searchAdsInAdset(args);
    // A non-array is an unreadable answer, NOT "nothing there". Treating null as empty is how a broken
    // port turns into a duplicate ad.
    if (!Array.isArray(rows)) return { failed: true };
    return { rows };
  } catch {
    return { failed: true };
  }
}

export async function decidePublish(
  { bindingHash, adsetId }: { bindingHash: string; adsetId: string },
  { searchAdsInAdset }: { searchAdsInAdset: SearchAdsInAdset }
): Promise<PublishDecision> {
  // Both checks come BEFORE the search: if the key or the target is unusable, there is no question worth
  // asking Meta.
  if (!usableHash(bindingHash)) return refuse("unusable_binding_hash");
  if (!usableAdsetId(adsetId)) return refuse("no_target_adset");

  const adName = buildAdName(bindingHash);
  const found = await searchOnce(searchAdsInAdset, { adsetId, adName });
  if (found.failed) return refuse("search_unreadable");

  const matches = keyedMatches(found.rows, bindingHash);
  if (matches.length > 1) return refuse("ambiguous_duplicate", { adIds: matches.map((m) => m.id) });

  if (matches.length === 1) {
    const m = matches[0];
    // The searcher was asked for one ad set, but trusting its scoping is not the same as checking it.
    // Adopting a match from elsewhere would report success while approved creative runs in a place
    // nobody approved.
    if (String(m.adset_id) !== String(adsetId)) return refuse("match_outside_target_adset", { adId: m.id });
    // The crash-recovery path: Meta already holds our ad, so the work is done.
    return { decision: "already_published", adId: m.id, adName, adsetId };
  }

  return { decision: "create", adName, adsetId, bindingHash };
}

/**
 * Called immediately AFTER a create returned. Its job is to confirm that exactly one ad carrying this
 * key now exists in the target ad set, and that it is the one Meta said it made.
 *
 * `created: true` is ALWAYS reported back: a create call WAS issued, so an unreadable verification is an
 * unknown outcome, never "nothing happened". The caller must not turn it into a second create.
 */
export async function verifyAfterCreate(
  { bindingHash, adsetId, adId }: { bindingHash: string; adsetId: string; adId: string },
  { searchAdsInAdset }: { searchAdsInAdset: SearchAdsInAdset }
): Promise<VerifyResult> {
  if (!usableHash(bindingHash)) return { ok: false, created: true, reason: "unusable_binding_hash" };
  if (!usableAdsetId(adsetId)) return { ok: false, created: true, reason: "no_target_adset" };

  const adName = buildAdName(bindingHash);
  const found = await searchOnce(searchAdsInAdset, { adsetId, adName });
  if (found.failed) return { ok: false, created: true, reason: "verify_unreadable" };

  const matches = keyedMatches(found.rows, bindingHash).filter((m) => String(m.adset_id) === String(adsetId));
  if (matches.length > 1) return { ok: false, created: true, reason: "ambiguous_duplicate", adIds: matches.map((m) => m.id) };
  if (matches.length === 1 && String(matches[0].id) === String(adId)) {
    return { ok: true, created: true, adId: matches[0].id, adName };
  }
  return { ok: false, created: true, reason: "created_ad_not_found" };
}
