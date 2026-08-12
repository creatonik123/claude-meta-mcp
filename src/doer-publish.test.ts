import { test } from "node:test";
import assert from "node:assert/strict";
import { executePublish } from "./doer-publish.ts";
import type { PublishDeps } from "./doer-publish.ts";
import type { AdRow } from "./publish-plan.ts";

// THE ONE NON-IDEMPOTENT WRITE IN ADPILOT.
//
// Pausing a paused ad is a no-op; a budget write is "set to X". Creating an ad is neither, and Meta
// offers no idempotency key for it. Two ads live where one was approved is spend that cannot be
// un-sent, so every branch below resolves toward NOT creating.
//
// Three layers, and they are deliberately not the same mechanism:
//   1. a per-APPROVAL lock — closes the race that search-before-create cannot: two runs searching
//      concurrently would both see nothing and both create. The lock is on the binding hash, not the
//      ad set, because the approval is the thing whose duplication costs money.
//   2. search-before-create — the durable check, because Meta itself holds the record. Survives a crash
//      at any instant, including immediately after the create returned.
//   3. verify-after-create — proves exactly one keyed ad exists and it is the one Meta named.
//
// The approval is consumed ONLY after verification. An unverified create leaves it OPEN on purpose: the
// keyed name means the next run finds the ad and adopts it, which is safe; re-creating is not.

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";
const ADSET = "120200999888";
const NAME = `AdPilot [apx:${HASH}]`;

function deps(over: Partial<PublishDeps> & { rows?: AdRow[]; rowsAfter?: AdRow[] } = {}) {
  const calls = { search: [] as unknown[], create: [] as unknown[], consume: [] as unknown[], acquire: [] as string[], release: [] as string[] };
  let created = false;
  const d: PublishDeps = {
    executionEnabled: true,
    coordinator: {
      acquire: async (k: string) => { calls.acquire.push(k); return true; },
      release: async (k: string) => { calls.release.push(k); },
      alreadyApplied: async () => false,
      markApplied: async () => {},
    },
    publisher: {
      searchAdsInAdset: async (a) => {
        calls.search.push(a);
        const after = over.rowsAfter ?? [{ id: "ad_new", name: NAME, adset_id: ADSET }];
        return created ? after : (over.rows ?? []);
      },
      createAd: async (a) => { calls.create.push(a); created = true; return { id: "ad_new" }; },
    },
    consumeApproval: async (h, ref) => { calls.consume.push({ h, ref }); return { consumed: true }; },
    ...over,
  } as PublishDeps;
  return { calls, d };
}

const ARGS = { approvalHash: HASH, targetEntityId: ADSET };

test("HAPPY PATH: creates ONCE under the keyed name, verifies, then consumes", async () => {
  const { calls, d } = deps();
  const r = await executePublish(ARGS, d);
  assert.equal(r.executed, true);
  assert.equal(r.verified, true);
  assert.equal(calls.create.length, 1, "exactly one create");
  assert.deepEqual(calls.create[0], { adsetId: ADSET, name: NAME, approvalHash: HASH });
  assert.equal(calls.search.length, 2, "one search before, one after");
  assert.deepEqual(calls.consume, [{ h: HASH, ref: "ad_new" }], "consumed once, bound to the ad");
});

test("execution disabled => no search, no create", async () => {
  const { calls, d } = deps({ executionEnabled: false });
  const r = await executePublish(ARGS, d);
  assert.equal(r.executed, false);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.search.length, 0, "an off switch must not even look");
});

test("the lock is per-APPROVAL, and it is always released", async () => {
  const { calls, d } = deps();
  await executePublish(ARGS, d);
  assert.deepEqual(calls.acquire, [`publish:${HASH}`], "the lock must key on the approval, not the ad set");
  assert.deepEqual(calls.release, [`publish:${HASH}`]);
});

test("lock held by another run => NO create", async () => {
  const { calls, d } = deps();
  d.coordinator.acquire = async () => false;
  const r = await executePublish(ARGS, d);
  assert.equal(r.executed, false);
  assert.match(r.reason!, /in progress|lock/i);
  assert.equal(calls.create.length, 0);
});

test("a lock store error FAILS CLOSED", async () => {
  const { calls, d } = deps();
  d.coordinator.acquire = async () => { throw new Error("lock table gone"); };
  const r = await executePublish(ARGS, d);
  assert.equal(r.executed, false);
  assert.equal(calls.create.length, 0);
});

test("the lock is released even when the create throws", async () => {
  const { calls, d } = deps();
  d.publisher.createAd = async () => { throw new Error("meta 500"); };
  await executePublish(ARGS, d);
  assert.deepEqual(calls.release, [`publish:${HASH}`], "a stuck lock would block this approval forever");
});

test("an unreadable pre-search REFUSES — never creates blind", async () => {
  const { calls, d } = deps();
  d.publisher.searchAdsInAdset = async () => { throw new Error("meta 500"); };
  const r = await executePublish(ARGS, d);
  assert.equal(r.executed, false);
  assert.match(r.reason!, /search_unreadable/);
  assert.equal(calls.create.length, 0, "not knowing is not permission");
});

test("ALREADY PUBLISHED: adopts, creates nothing, and settles the approval", async () => {
  const { calls, d } = deps({ rows: [{ id: "ad_1", name: NAME, adset_id: ADSET }] });
  const r = await executePublish(ARGS, d);
  assert.equal(calls.create.length, 0, "the ad exists — creating again is duplicated spend");
  assert.equal(r.executed, false);
  assert.equal(r.adopted, true);
  assert.deepEqual(calls.consume, [{ h: HASH, ref: "ad_1" }], "settled so it stops being re-offered");
});

test("a CREATE THAT THROWS is an unknown outcome: no retry, no consume, flagged for reconcile", async () => {
  // Meta may or may not have created it. Guessing either way is wrong; the next run's
  // search-before-create will find it if it exists.
  const { calls, d } = deps();
  // The override must still RECORD the attempt, or "exactly one attempt" is unprovable — an earlier
  // version of this test replaced the recorder and then asserted on a counter that could never move.
  d.publisher.createAd = async (a) => { calls.create.push(a); throw new Error("gateway timeout"); };
  const r = await executePublish(ARGS, d);
  assert.equal(calls.create.length, 1, "exactly one attempt — never retried");
  assert.equal(r.verified, false);
  assert.ok(r.reconcile, "an ambiguous create must be surfaced for a human");
  assert.equal(calls.consume.length, 0, "an unknown outcome must never be settled as done");
});

test("a create returning no usable id is also unknown, not success", async () => {
  for (const bad of [{}, { id: "" }, { id: "   " }, { id: 123 }, null]) {
    const { calls, d } = deps();
    d.publisher.createAd = async () => bad as { id: string };
    const r = await executePublish(ARGS, d);
    assert.notEqual(r.verified, true, JSON.stringify(bad));
    assert.equal(calls.consume.length, 0, JSON.stringify(bad));
  }
});

test("verification failure => NOT consumed, and reported for reconcile", async () => {
  const { calls, d } = deps({ rowsAfter: [] }); // create returned, but nothing is there
  const r = await executePublish(ARGS, d);
  assert.equal(calls.create.length, 1);
  assert.equal(r.verified, false);
  assert.equal(calls.consume.length, 0, "unconfirmed work stays open for the keyed re-run");
  assert.ok(r.reconcile);
});

test("duplicates found AFTER the create are reported, never consumed", async () => {
  const { calls, d } = deps({
    rowsAfter: [
      { id: "ad_new", name: NAME, adset_id: ADSET },
      { id: "ad_dup", name: NAME, adset_id: ADSET },
    ],
  });
  const r = await executePublish(ARGS, d);
  assert.equal(r.verified, false);
  assert.match(r.reconcile!, /ambiguous/i);
  assert.equal(calls.consume.length, 0);
});

test("a consume failure after a VERIFIED create still reports the publish", async () => {
  // The ad is live and verified. Reporting failure would be a lie and would invite a re-run; the keyed
  // name means the next run adopts this ad instead of creating another.
  const { d } = deps();
  d.consumeApproval = async () => { throw new Error("db down"); };
  const r = await executePublish(ARGS, d);
  assert.equal(r.executed, true);
  assert.equal(r.verified, true);
  assert.equal(r.consumeFailed, true, "the unsettled approval must be visible, not swallowed");
});

test("an unusable approval hash or target refuses before any Meta call", async () => {
  for (const args of [
    { approvalHash: "", targetEntityId: ADSET },
    { approvalHash: HASH.toUpperCase(), targetEntityId: ADSET },
    { approvalHash: HASH, targetEntityId: "" },
    { approvalHash: HASH, targetEntityId: "   " },
  ]) {
    const { calls, d } = deps();
    const r = await executePublish(args, d);
    assert.equal(r.executed, false, JSON.stringify(args));
    assert.equal(calls.search.length, 0, "no question worth asking Meta");
    assert.equal(calls.create.length, 0);
  }
});

test("missing publisher wiring is a structured no-write, not a crash", async () => {
  const { d } = deps();
  // @ts-expect-error deliberately unwired, as a half-configured deployment would be
  d.publisher = undefined;
  const r = await executePublish(ARGS, d);
  assert.equal(r.executed, false);
  assert.match(r.reason!, /not wired|unavailable/i);
});
