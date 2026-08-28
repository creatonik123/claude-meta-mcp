import { test } from "node:test";
import assert from "node:assert/strict";
import { executePublish } from "./doer-publish.ts";
import type { PublishDeps } from "./doer-publish.ts";

// The companion rendering must travel all the way to the publisher, and BOTH approvals must be
// consumed when one ad carries both. If only the primary were consumed, the companion would still be
// unconsumed and the next run would publish it as a second ad — precisely the duplicate that was
// fixed app-side in f5ef444. Two layers, because the cost of the fault is an ad that cannot be
// un-created.

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";
const COMPANION = "a8c894bee8a29e19de28c7af0b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";
const ADSET = "120200999888";
const AD_NAME = `AdPilot [apx:${HASH}]`;

function deps(over: Partial<PublishDeps> = {}) {
  const created: Array<Record<string, unknown>> = [];
  const consumed: Array<{ hash: string; ref: string }> = [];
  let searchCalls = 0;
  const d = {
    executionEnabled: true,
    coordinator: { acquire: async () => true, release: async () => {} },
    consumeApproval: async (hash: string, ref: string) => { consumed.push({ hash, ref }); },
    publisher: {
      searchAdsInAdset: async () => {
        searchCalls++;
        // Before create: nothing. After create: exactly the keyed ad.
        return searchCalls === 1 ? [] : [{ id: "ad_new", name: AD_NAME, adset_id: ADSET }];
      },
      createAd: async (args: Record<string, unknown>) => { created.push(args); return { id: "ad_new" }; },
    },
    ...over,
  } as unknown as PublishDeps;
  return { d, created, consumed };
}

test("the companion hash reaches the publisher", async () => {
  const { d, created } = deps();
  const out = await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: COMPANION } as any, d);
  assert.equal(out.executed, true);
  assert.equal(out.verified, true);
  assert.equal(created.length, 1, "still exactly ONE ad");
  assert.equal(created[0].companionHash, COMPANION, "without this the vertical is silently dropped");
});

test("BOTH approvals are consumed, against the same ad", async () => {
  const { d, consumed } = deps();
  await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: COMPANION } as any, d);
  assert.deepEqual(consumed.map((c) => c.hash).sort(), [COMPANION, HASH].sort());
  for (const c of consumed) assert.equal(c.ref, "ad_new", "both must point at the ad they actually produced");
});

test("with NO companion, exactly one approval is consumed — unchanged behaviour", async () => {
  const { d, consumed, created } = deps();
  await executePublish({ approvalHash: HASH, targetEntityId: ADSET } as any, d);
  assert.deepEqual(consumed.map((c) => c.hash), [HASH]);
  assert.equal(created[0].companionHash, undefined);
});

test("a malformed companion hash is REFUSED before any ad is created", async () => {
  for (const bad of ["not-a-hash", "abc", "3f2c8a91", HASH.toUpperCase(), "  "]) {
    const { d, created } = deps();
    const out = await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: bad } as any, d);
    assert.equal(created.length, 0, `companion ${JSON.stringify(bad)} must not reach a create`);
    assert.equal(out.executed, false);
  }
});

test("a companion equal to the primary is REFUSED before any ad is created", async () => {
  const { d, created } = deps();
  const out = await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: HASH } as any, d);
  assert.equal(created.length, 0);
  assert.equal(out.executed, false);
});

test("a publisher that THROWS consumes nothing — the approvals survive for the retry", async () => {
  const { d, consumed } = deps({
    publisher: {
      searchAdsInAdset: async () => [],
      createAd: async () => { throw new Error("meta 500"); },
    } as any,
  });
  const out = await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: COMPANION } as any, d);
  assert.equal(out.verified, false);
  assert.deepEqual(consumed, [], "an unknown outcome must never spend either approval");
});

test("an unverified create consumes NEITHER approval", async () => {
  let n = 0;
  const { d, consumed } = deps({
    publisher: {
      // Search returns nothing even after the create: the ad cannot be proven.
      searchAdsInAdset: async () => { n++; return []; },
      createAd: async () => ({ id: "ad_new" }),
    } as any,
  });
  const out = await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: COMPANION } as any, d);
  assert.equal(out.verified, false);
  assert.deepEqual(consumed, []);
});

test("a failure consuming the COMPANION is reported, never silently swallowed", async () => {
  // If the companion stays unconsumed and nobody says so, the next run republishes it as a second ad.
  const { d } = deps({
    consumeApproval: async (hash: string) => { if (hash === COMPANION) throw new Error("db down"); },
  } as any);
  const out = await executePublish({ approvalHash: HASH, targetEntityId: ADSET, companionHash: COMPANION } as any, d);
  assert.equal(out.verified, true, "the ad exists and that fact must not be lost");
  assert.equal((out as any).consumeFailed, true, "the bookkeeping gap must be visible to an operator");
});
