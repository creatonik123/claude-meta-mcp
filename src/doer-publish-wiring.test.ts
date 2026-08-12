import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDecision } from "./doer.ts";
import type { DoerDeps } from "./doer.ts";
import type { Decision } from "./guard.ts";

// Routing an allowed publish to the create path — and re-reading the approval AT WRITE TIME.
//
// The guard hands the executor ONLY `{ approvalHash }` (validateArgs rejects everything else), so the
// destination cannot be smuggled in by a caller. That means the doer has to resolve the target itself,
// from the same immutable record the guard checked. This is the wiring that does it.
//
// Re-reading is not redundant with the guard's own check. The guard decided at time T; the write happens
// at T+n. In between, the approval can be consumed by another run. Re-reading immediately before the
// create narrows that window to the lock's width — and the lock is on this very approval.

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";
const ADSET = "120200999888";
const NAME = `AdPilot [apx:${HASH}]`;
const allowed: Decision = { allowed: true, effectiveArgs: { approvalHash: HASH } };

function deps(over: Record<string, unknown> = {}) {
  const calls = { create: [] as unknown[], search: [] as unknown[], consume: [] as unknown[], approvalReads: [] as string[] };
  let created = false;
  const d = {
    executionEnabled: true,
    writer: { post: async () => { throw new Error("the update path must never be used for publish"); } },
    reader: { get: async () => ({}) },
    coordinator: { acquire: async () => true, release: async () => {}, alreadyApplied: async () => false, markApplied: async () => {} },
    currencyOffset: 100,
    publish: {
      approvalByHash: async (h: string) => { calls.approvalReads.push(h); return { consumed: false, targetEntityId: ADSET }; },
      publisher: {
        searchAdsInAdset: async (a: unknown) => { calls.search.push(a); return created ? [{ id: "ad_new", name: NAME, adset_id: ADSET }] : []; },
        createAd: async (a: unknown) => { calls.create.push(a); created = true; return { id: "ad_new" }; },
      },
      consumeApproval: async (h: string, ref: string) => { calls.consume.push({ h, ref }); return { consumed: true }; },
    },
    ...over,
  } as unknown as DoerDeps;
  return { calls, d };
}

test("an allowed publish routes to the CREATE path, not the update path", async () => {
  const { calls, d } = deps();
  const r = await executeDecision("publish_approved_creative", allowed, d);
  assert.equal(r.executed, true);
  assert.equal(calls.create.length, 1, "the ad must actually be created via the publisher");
  assert.deepEqual(calls.create[0], { adsetId: ADSET, name: NAME, approvalHash: HASH });
  assert.deepEqual(calls.consume, [{ h: HASH, ref: "ad_new" }]);
});

test("the destination is read from the APPROVAL RECORD, never from args", async () => {
  const { calls, d } = deps();
  await executeDecision("publish_approved_creative", allowed, d);
  assert.deepEqual(calls.approvalReads, [HASH], "the approval must be re-read at write time");
});

test("an approval consumed between the guard's decision and the write => NO create", async () => {
  // The race the re-read exists to catch.
  const { calls, d } = deps();
  (d as unknown as { publish: { approvalByHash: unknown } }).publish.approvalByHash =
    async () => ({ consumed: true, targetEntityId: ADSET });
  const r = await executeDecision("publish_approved_creative", allowed, d);
  assert.equal(r.executed, false);
  assert.match((r as { reason: string }).reason, /consumed/i);
  assert.equal(calls.create.length, 0);
});

test("an approval that vanished => NO create", async () => {
  const { calls, d } = deps();
  (d as unknown as { publish: { approvalByHash: unknown } }).publish.approvalByHash = async () => null;
  const r = await executeDecision("publish_approved_creative", allowed, d);
  assert.equal(r.executed, false);
  assert.equal(calls.create.length, 0);
});

test("an approval carrying no target => NO create", async () => {
  for (const t of [null, "", "   ", undefined]) {
    const { calls, d } = deps();
    (d as unknown as { publish: { approvalByHash: unknown } }).publish.approvalByHash =
      async () => ({ consumed: false, targetEntityId: t });
    const r = await executeDecision("publish_approved_creative", allowed, d);
    assert.equal(r.executed, false, JSON.stringify(t));
    assert.equal(calls.create.length, 0);
  }
});

test("an unreadable approval FAILS CLOSED — no create", async () => {
  const { calls, d } = deps();
  (d as unknown as { publish: { approvalByHash: unknown } }).publish.approvalByHash =
    async () => { throw new Error("db down"); };
  const r = await executeDecision("publish_approved_creative", allowed, d);
  assert.equal(r.executed, false);
  assert.equal(calls.create.length, 0, "not knowing whether an approval is spent is not permission");
});

test("publish wiring absent => structured no-write, and the update path is still never used", async () => {
  const { calls, d } = deps({ publish: undefined });
  const r = await executeDecision("publish_approved_creative", allowed, d);
  assert.equal(r.executed, false);
  assert.equal(calls.create.length, 0);
  assert.match((r as { reason: string }).reason, /publish/i);
});

test("execution disabled => no approval read, no create", async () => {
  const { calls, d } = deps({ executionEnabled: false });
  const r = await executeDecision("publish_approved_creative", allowed, d);
  assert.equal(r.executed, false);
  assert.equal(calls.approvalReads.length, 0, "an off switch must not even look");
  assert.equal(calls.create.length, 0);
});

test("a refused decision never reaches the create path", async () => {
  const { calls, d } = deps();
  const refused: Decision = { allowed: false, code: "action_mode_off", reason: "off" };
  const r = await executeDecision("publish_approved_creative", refused, d);
  assert.equal(r.executed, false);
  assert.equal(calls.create.length, 0);
});
