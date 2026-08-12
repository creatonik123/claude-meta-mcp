import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePublish, verifyAfterCreate } from "./publish-plan.ts";
import type { AdRow } from "./publish-plan.ts";

// Search-before-create / search-after-create, guard-side.
//
// THE RULE: AdPilot may create an ad only when it can SEE that the ad is not already there. Every other
// outcome — an unreadable search, two ads carrying one key, a match in an ad set nobody approved, a key
// we cannot trust — resolves to doing nothing. Publishing one ad too few is a Slack message; publishing
// one too many is spend that cannot be un-sent, and Meta offers no idempotency key for ad creation.
//
// Ported from app/lib/creative/publish-plan.js, which the app tests cover in parallel. The behaviours
// must stay identical: the naming key is shared through committed vectors, and so is this logic's job.

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";
const OTHER = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const ADSET = "120200999888";
const NAME = `AdPilot [apx:${HASH}]`;

function searcher(rows: AdRow[] | null | undefined | (() => never), opts: { throws?: boolean } = {}) {
  const calls: unknown[] = [];
  const fn = async (args: unknown) => {
    calls.push(args);
    if (opts.throws) throw new Error("meta 500");
    return rows as AdRow[];
  };
  return { fn, calls };
}

test("nothing found in the target ad set => CREATE", async () => {
  const s = searcher([]);
  const d = await decidePublish({ bindingHash: HASH, adsetId: ADSET }, { searchAdsInAdset: s.fn });
  assert.equal(d.decision, "create");
  assert.equal(d.adName, NAME);
  assert.equal(d.adsetId, ADSET);
  assert.equal(s.calls.length, 1, "exactly one search, never retried");
});

test("our ad already there => ALREADY_PUBLISHED, never a second create", async () => {
  const s = searcher([{ id: "ad_1", name: NAME, adset_id: ADSET }]);
  const d = await decidePublish({ bindingHash: HASH, adsetId: ADSET }, { searchAdsInAdset: s.fn });
  assert.equal(d.decision, "already_published");
  assert.equal(d.adId, "ad_1");
});

test("an unreadable search REFUSES — a thrown search and an empty ad set must never look alike", async () => {
  const s = searcher([], { throws: true });
  const d = await decidePublish({ bindingHash: HASH, adsetId: ADSET }, { searchAdsInAdset: s.fn });
  assert.equal(d.decision, "refuse");
  assert.equal(d.reason, "search_unreadable");
});

test("a NON-ARRAY answer is unreadable, not 'nothing there'", async () => {
  // Treating null as empty is precisely how a broken port becomes a duplicate ad.
  for (const bad of [null, undefined, {} as unknown as AdRow[], "rows" as unknown as AdRow[]]) {
    const s = searcher(bad as AdRow[]);
    const d = await decidePublish({ bindingHash: HASH, adsetId: ADSET }, { searchAdsInAdset: s.fn });
    assert.equal(d.reason, "search_unreadable", JSON.stringify(bad));
  }
});

test("two ads carrying the same key => AMBIGUOUS, refuse and name them", async () => {
  const s = searcher([
    { id: "ad_1", name: NAME, adset_id: ADSET },
    { id: "ad_2", name: NAME, adset_id: ADSET },
  ]);
  const d = await decidePublish({ bindingHash: HASH, adsetId: ADSET }, { searchAdsInAdset: s.fn });
  assert.equal(d.reason, "ambiguous_duplicate");
  assert.deepEqual(d.adIds, ["ad_1", "ad_2"]);
});

test("a match in a DIFFERENT ad set is refused, never adopted", async () => {
  // The searcher was asked for one ad set, but trusting its scoping is not checking it. Adopting a
  // match from elsewhere would report success while approved creative runs where nobody approved it.
  const s = searcher([{ id: "ad_9", name: NAME, adset_id: "999000111" }]);
  const d = await decidePublish({ bindingHash: HASH, adsetId: ADSET }, { searchAdsInAdset: s.fn });
  assert.equal(d.reason, "match_outside_target_adset");
  assert.equal(d.adId, "ad_9");
});

test("an unusable hash or target refuses BEFORE any search", async () => {
  for (const [h, a] of [["", ADSET], [HASH.toUpperCase(), ADSET], ["xyz", ADSET], [HASH, ""], [HASH, "   "]]) {
    const s = searcher([]);
    const d = await decidePublish({ bindingHash: h, adsetId: a }, { searchAdsInAdset: s.fn });
    assert.equal(d.decision, "refuse", JSON.stringify([h, a]));
    assert.equal(s.calls.length, 0, "no question is worth asking Meta about an unusable approval");
  }
});

test("a human's ad in the same ad set is ignored — we create ours", async () => {
  const s = searcher([
    { id: "human_1", name: "Winter promo", adset_id: ADSET },
    { id: "other_1", name: `AdPilot [apx:${OTHER}]`, adset_id: ADSET },
  ]);
  const d = await decidePublish({ bindingHash: HASH, adsetId: ADSET }, { searchAdsInAdset: s.fn });
  assert.equal(d.decision, "create", "another approval's ad is not ours");
});

test("a human-renamed copy of OUR ad is still adopted", async () => {
  const s = searcher([{ id: "ad_r", name: `Copy of ${NAME} (edited)`, adset_id: ADSET }]);
  const d = await decidePublish({ bindingHash: HASH, adsetId: ADSET }, { searchAdsInAdset: s.fn });
  assert.equal(d.decision, "already_published");
  assert.equal(d.adId, "ad_r");
});

// ---- verifyAfterCreate -------------------------------------------------

test("verify: exactly one keyed ad, and it is the one Meta named => ok", async () => {
  const s = searcher([{ id: "ad_new", name: NAME, adset_id: ADSET }]);
  const v = await verifyAfterCreate({ bindingHash: HASH, adsetId: ADSET, adId: "ad_new" }, { searchAdsInAdset: s.fn });
  assert.equal(v.ok, true);
  assert.equal(v.created, true);
});

test("verify ALWAYS reports created:true, so an unreadable check is never re-driven into a second create", async () => {
  const cases: Array<[string, ReturnType<typeof searcher>]> = [
    ["throws", searcher([], { throws: true })],
    ["non-array", searcher(null as unknown as AdRow[])],
    ["missing", searcher([])],
  ];
  for (const [label, s] of cases) {
    const v = await verifyAfterCreate({ bindingHash: HASH, adsetId: ADSET, adId: "ad_new" }, { searchAdsInAdset: s.fn });
    assert.equal(v.ok, false, label);
    assert.equal(v.created, true, `${label}: a create WAS issued — this is unknown, not "nothing happened"`);
  }
});

test("verify: a different ad id than Meta reported => created_ad_not_found", async () => {
  const s = searcher([{ id: "someone_else", name: NAME, adset_id: ADSET }]);
  const v = await verifyAfterCreate({ bindingHash: HASH, adsetId: ADSET, adId: "ad_new" }, { searchAdsInAdset: s.fn });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "created_ad_not_found");
});

test("verify: duplicates after the create => ambiguous, and both ids are surfaced", async () => {
  const s = searcher([
    { id: "ad_new", name: NAME, adset_id: ADSET },
    { id: "ad_dup", name: NAME, adset_id: ADSET },
  ]);
  const v = await verifyAfterCreate({ bindingHash: HASH, adsetId: ADSET, adId: "ad_new" }, { searchAdsInAdset: s.fn });
  assert.equal(v.reason, "ambiguous_duplicate");
  assert.deepEqual(v.adIds, ["ad_new", "ad_dup"]);
});

test("verify ignores matches outside the target ad set", async () => {
  const s = searcher([{ id: "ad_new", name: NAME, adset_id: "999000111" }]);
  const v = await verifyAfterCreate({ bindingHash: HASH, adsetId: ADSET, adId: "ad_new" }, { searchAdsInAdset: s.fn });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "created_ad_not_found");
});

test("verify: one search, never retried", async () => {
  const s = searcher([{ id: "ad_new", name: NAME, adset_id: ADSET }]);
  await verifyAfterCreate({ bindingHash: HASH, adsetId: ADSET, adId: "ad_new" }, { searchAdsInAdset: s.fn });
  assert.equal(s.calls.length, 1);
});
