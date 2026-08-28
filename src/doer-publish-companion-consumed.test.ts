import { test } from "node:test";
import assert from "node:assert/strict";
import { executePublish } from "./doer-publish.ts";
import type { PublishDeps } from "./doer-publish.ts";

// The guard verifies the companion's IDENTITY (same words, destination, form, page; different image).
// It did not verify that the companion is still UNSPENT. The app's worklist excludes consumed rows, so
// in practice it cannot send one — but "the app would not do that" is exactly the reasoning the guard
// exists to refuse. A consumed companion means that image already appeared in an ad, and republishing
// it inside a second ad puts the same rendering in two live ads.
//
// A consumed companion DROPS the companion and publishes the primary alone. It does not refuse the
// whole publish: losing an ad entirely is worse than losing one rendering of it, and the primary is
// independently approved. The vertical stays unconsumed, and the app's own
// `creative_already_published` check stops it being picked up as a lone primary later.

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";
const COMPANION = "a8c894bee8a29e19de28c7af0b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";
const ADSET = "120200999888";
const AD_NAME = `AdPilot [apx:${HASH}]`;

function deps(over: Record<string, unknown> = {}) {
  const created: Array<Record<string, unknown>> = [];
  const consumed: string[] = [];
  let searchCalls = 0;
  const d = {
    executionEnabled: true,
    coordinator: { acquire: async () => true, release: async () => {} },
    consumeApproval: async (hash: string) => { consumed.push(hash); },
    isApprovalConsumed: async () => false,
    publisher: {
      searchAdsInAdset: async () => {
        searchCalls++;
        return searchCalls === 1 ? [] : [{ id: "ad_new", name: AD_NAME, adset_id: ADSET }];
      },
      createAd: async (args: Record<string, unknown>) => { created.push(args); return { id: "ad_new" }; },
    },
    ...over,
  } as unknown as PublishDeps;
  return { d, created, consumed };
}

test("an UNCONSUMED companion is published, as before", async () => {
  const { d, created, consumed } = deps();
  const out = await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: COMPANION } as any, d);
  assert.equal(out.verified, true);
  assert.equal(created[0].companionHash, COMPANION);
  assert.deepEqual(consumed.sort(), [COMPANION, HASH].sort());
});

test("a CONSUMED companion is dropped — the primary still publishes, alone", async () => {
  const { d, created, consumed } = deps({
    isApprovalConsumed: async (h: string) => h === COMPANION,
  });
  const out = await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: COMPANION } as any, d);
  assert.equal(out.verified, true, "an ad must still be created — losing the ad is worse than losing a rendering");
  assert.equal(created.length, 1);
  assert.equal(created[0].companionHash, undefined, "that image is already live in another ad");
  assert.deepEqual(consumed, [HASH], "a spent approval must not be spent twice");
});

test("a consumption check that THROWS drops the companion rather than risking a repeat", async () => {
  const { d, created, consumed } = deps({
    isApprovalConsumed: async () => { throw new Error("db down"); },
  });
  const out = await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: COMPANION } as any, d);
  assert.equal(out.verified, true);
  assert.equal(created[0].companionHash, undefined, "unprovable freshness is not permission to reuse");
  assert.deepEqual(consumed, [HASH]);
});

test("a MISSING consumption check drops the companion — never assumes unspent", async () => {
  const base = deps();
  delete (base.d as unknown as Record<string, unknown>).isApprovalConsumed;
  const out = await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: COMPANION } as any, base.d);
  assert.equal(out.verified, true);
  assert.equal(base.created[0].companionHash, undefined);
});

test("the PRIMARY being consumed is NOT this check's business", async () => {
  // decidePublish's search-before-create already handles an already-published primary. This check must
  // not start refusing primaries, or a re-run after an unverified create could never resolve itself.
  const { d, created } = deps({ isApprovalConsumed: async (h: string) => h === HASH });
  const out = await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: COMPANION } as any, d);
  assert.equal(out.verified, true);
  assert.equal(created[0].companionHash, COMPANION, "the companion is fresh and must still ship");
});

test("with no companion the check is never consulted", async () => {
  let asked = 0;
  const { d, created } = deps({ isApprovalConsumed: async () => { asked++; return false; } });
  await executePublish({ approvalHash: HASH, targetEntityId: ADSET } as any, d);
  assert.equal(asked, 0, "an ordinary single-format publish must not depend on this at all");
  assert.equal(created[0].companionHash, undefined);
});
