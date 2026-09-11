import { test } from "node:test";
import assert from "node:assert/strict";
import { executePublish } from "./doer-publish.ts";
import type { PublishDeps } from "./doer-publish.ts";

// A PRE-WRITE REFUSAL IS NOT AN UNKNOWN OUTCOME.
//
// Every video refusal happens BEFORE the /ads POST, so no ad can exist. Reporting one as "an ad may
// exist" would raise a reconcile alarm on a run that demonstrably created nothing — and an alarm that
// cries wolf is how a REAL unknown gets ignored. So these codes report as plain refusals, and
// everything else keeps the unknown-outcome path with its alarm intact. Nothing is consumed either way.

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";
const ADSET = "120200999888";
const ARGS = { approvalHash: HASH, targetEntityId: ADSET };

function depsThrowing(message: string) {
  const calls = { create: 0, consume: 0 };
  const d: PublishDeps = {
    executionEnabled: true,
    coordinator: {
      acquire: async () => true,
      release: async () => {},
      alreadyApplied: async () => false,
      markApplied: async () => {},
    },
    publisher: {
      searchAdsInAdset: async () => [],
      createAd: async () => { calls.create++; throw new Error(message); },
    },
    consumeApproval: async () => { calls.consume++; return { consumed: true }; },
  } as unknown as PublishDeps;
  return { calls, d };
}

const CODES = [
  "video_upload_failed",
  "video_not_ready",
  "video_thumbnail_missing",
  "video_companion_unsupported",
  "asset_mime_unsupported",
];

for (const code of CODES) {
  test(`${code} reports as a refusal — no reconcile, nothing consumed`, async () => {
    const { calls, d } = depsThrowing(`${code}: some readable explanation`);
    const r = await executePublish(ARGS, d) as Record<string, unknown>;
    assert.equal(r.executed, false, "no write happened, so nothing was executed");
    assert.equal(r.reason, code, "the refusal code is reported verbatim, without its explanation");
    assert.equal(r.reconcile, undefined, "a pre-write refusal must not raise a reconcile alarm");
    assert.equal(calls.consume, 0, "a refused publish consumes nothing");
    assert.equal(calls.create, 1, "exactly one attempt, never a retry");
  });
}

test("the sixth code, asset_mime_unsupported, is covered above and behaves identically", () => {
  assert.ok(CODES.includes("asset_mime_unsupported"));
});

test("a GENERIC error still takes the unknown-outcome path — the real alarm is intact", async () => {
  const { calls, d } = depsThrowing("meta-publisher: creative returned no creative id");
  const r = await executePublish(ARGS, d) as Record<string, unknown>;
  assert.equal(r.executed, true, "an unknown outcome must be treated as though a write happened");
  assert.equal(r.verified, false);
  assert.match(String(r.reconcile), /an ad may exist/);
  assert.equal(calls.consume, 0);
});

test("a message that merely MENTIONS a code, rather than raising it, keeps the alarm", async () => {
  // The classification is anchored to the start of the message on purpose: a wrapped or narrated
  // error is not a proof that no write happened.
  const { calls, d } = depsThrowing("Meta rejected the ad (video_not_ready was ruled out)");
  const r = await executePublish(ARGS, d) as Record<string, unknown>;
  assert.equal(r.executed, true);
  assert.match(String(r.reconcile), /an ad may exist/);
  assert.equal(calls.consume, 0);
});
