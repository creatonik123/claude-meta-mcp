/**
 * The natural key that makes ad CREATION idempotent — guard-side.
 *
 * Every other write AdPilot performs is idempotent by nature: pausing a paused ad is a no-op, and a
 * budget write is "set to X", not "add X". Creating an ad is neither, and Meta offers no idempotency
 * key for it. A retry, a double-clicked approval, or a crash in the gap between "Meta created it" and
 * "we recorded it" would each leave a second live ad spending real money. Meta writes cannot be un-sent.
 *
 * So the approval's own binding hash is written into the ad's NAME. Before creating, the doer searches
 * the target ad set for that exact name; if it is already there, the work is done. The record of what
 * was created therefore lives in Meta itself — the only store guaranteed to survive a crash on our side
 * at any instant, including immediately after the create call returned.
 *
 * ⚠️ THIS IS A CROSS-LANGUAGE CONTRACT. app/lib/creative/publish-naming.js implements the same scheme.
 * Both are pinned to app/lib/creative/publish-name-vectors.json; a one-character divergence makes the
 * pre-create search miss and publishes a duplicate. Change the vectors, never one side alone.
 *
 * Pure string functions. No Meta, no network, no clock.
 */

// The app's fingerprint() emits lowercase 64-hex; this is the only shape accepted.
const BINDING_HASH_RE = /^[0-9a-f]{64}$/;

// Marker + hash, e.g. "AdPilot [apx:3f2c…2d]". Verbose enough that a human in Ads Manager can see the
// ad is machine-created, distinctive enough that a human-authored name can never be mistaken for ours.
// Unanchored on purpose: a human may rename around the marker, and such an ad is still OURS — adopting
// it is correct, creating a second one is not.
const MARKER_RE = /\[apx:([0-9a-f]{64})\]/;

// A CONSERVATIVE self-imposed cap, NOT a verified Meta limit. If Meta ever silently truncated a long ad
// name the key would be destroyed and every run would create a duplicate, so the name is kept far
// shorter than any plausible limit rather than relying on one.
export const AD_NAME_MAX = 120;

export function assertBindingHash(bindingHash: string): string {
  if (typeof bindingHash !== "string" || !BINDING_HASH_RE.test(bindingHash)) {
    // Deliberately does not echo the value: it is a hash, but an untrusted one, and this message
    // reaches logs.
    throw new Error("publish refused: binding hash is not a lowercase 64-hex string");
  }
  return bindingHash;
}

// The one and only name an approval may be published under.
export function buildAdName(bindingHash: string): string {
  const h = assertBindingHash(bindingHash);
  const name = `AdPilot [apx:${h}]`;
  // Belt and braces: if the format ever grows past the budget, refuse rather than let truncation
  // silently destroy the key.
  if (name.length > AD_NAME_MAX) throw new Error("publish refused: ad name exceeds the length budget");
  return name;
}

// Reads our key back out of a name Meta returned. Returns null for anything that is not ours, so a
// human's ad is never adopted as an AdPilot publish.
export function bindingHashFromAdName(name: string): string | null {
  if (typeof name !== "string") return null;
  const m = MARKER_RE.exec(name);
  return m ? m[1] : null;
}

export { BINDING_HASH_RE };
