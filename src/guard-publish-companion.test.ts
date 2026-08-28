import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type GuardConfig, type GuardDeps } from "./guard.ts";

// The guard's publish branch deliberately narrowed effectiveArgs to `{ approvalHash }`, so that no
// caller-supplied id could influence where a creative lands. That narrowing also silently dropped the
// companion rendering — the field would have travelled from the app, through the tool schema and
// guardArgs, and died here, with the vertical never appearing and no error anywhere.
//
// The narrowing's PURPOSE is preserved exactly: the DESTINATION still comes only from the primary
// approval record. A companion hash cannot name a destination — it names a second image, and the
// publisher independently verifies it belongs to the same approved creative before using it.

const baseConfig: GuardConfig = {
  managedAccountId: "act_2218833115522041",
  allowedCampaignIds: ["120200123"],
  deniedAccountIds: ["act_1133075730765139"],
  actionModes: { pause: "auto", adjust_adset_budget: "auto", publish_approved_creative: "auto" },
  accountTimezone: "Australia/North",
  killSwitchEnvFlag: "ADPILOT_KILL_ALL",
  budgetClamp: {
    maxSingleChangePct: 25,
    maxAccountChangePerDayPct: 20,
    blockLifetimeBudgetWrites: true,
    blockCboAdsetBudgetWrites: true,
    crossDayMaxMultipleVs30dBaseline: 2.0,
  },
  spendCaps: {
    dailyAud: 340,
    monthlyAud: 9250,
    sameDayDecisionFractionOfDailyCap: 0.8,
    monthEndRevisionBufferAud: 300,
  },
  targets: { targetCplAud: 21.5, provisional: true },
  schemaVersion: 1,
};

const TARGET_ADSET = "120200999888";
const HASH = "a".repeat(64);
const COMPANION = "b".repeat(64);

function makeDeps(): GuardDeps {
  return {
    config: { ...baseConfig },
    now: () => new Date("2026-06-14T10:00:00Z"),
    env: {},
    db: {
      schemaVersion: async () => 1,
      killSwitchRow: async () => false,
      approvalByHash: async () => ({ consumed: false, targetEntityId: TARGET_ADSET }),
      startOfDayBudget: async () => 100,
      accountStartOfDayTotal: async () => 1000,
      budgetBaseline30d: async () => 1000,
    },
    meta: {
      entityAccountId: async () => "act_2218833115522041",
      entityCampaignId: async () => "120200123",
      currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }),
      realisedSpend: async () => ({ today: 50, monthToDate: 2000, dateStop: "2026-06-14", complete: true }),
      accountActiveDailyBudgetTotal: async () => ({ total: 1000, entityCounted: 100 }),
    },
  };
}

const publish = (args: Record<string, unknown>) => evaluate("publish_approved_creative", args, makeDeps());

test("a well-formed companion SURVIVES into effectiveArgs", async () => {
  const d = await publish({ approvalHash: HASH, companionHash: COMPANION });
  assert.equal(d.allowed, true, `refused: ${JSON.stringify(d)}`);
  assert.equal((d as any).effectiveArgs.companionHash, COMPANION, "dropped here means the vertical never ships");
});

test("the primary approvalHash is still the one that reaches the executor", async () => {
  const d = await publish({ approvalHash: HASH, companionHash: COMPANION });
  assert.equal((d as any).effectiveArgs.approvalHash, HASH);
});

test("NO companion -> effectiveArgs is exactly what it always was", async () => {
  const d = await publish({ approvalHash: HASH });
  assert.equal(d.allowed, true);
  assert.deepEqual((d as any).effectiveArgs, { approvalHash: HASH }, "the single-format shape must not change");
});

test("a caller cannot smuggle a destination — extra fields REFUSE the whole call", async () => {
  // Stronger than the filtering this test first assumed: the guard rejects an unrecognised field
  // outright rather than quietly ignoring it. companionHash is the ONLY field added to that set.
  for (const smuggled of [
    { targetEntityId: "999666333" },
    { adsetId: "999666333" },
    { status: "ACTIVE" },
    { dailyBudget: 99999 },
  ]) {
    const d = await publish({ approvalHash: HASH, companionHash: COMPANION, ...smuggled });
    assert.equal(d.allowed, false, `${JSON.stringify(smuggled)} was accepted`);
    assert.equal((d as any).code, "args_extra");
  }
});

test("effectiveArgs carries EXACTLY the two permitted fields, nothing more", async () => {
  const d = await publish({ approvalHash: HASH, companionHash: COMPANION });
  assert.deepEqual(Object.keys((d as any).effectiveArgs).sort(), ["approvalHash", "companionHash"],
    "the destination comes from the approval record alone");
});

test("a MALFORMED companion is dropped, and the publish still proceeds", async () => {
  // Dropping beats refusing: the primary is independently approved, and losing the whole ad is worse
  // than losing one rendering. The doer refuses a malformed companion too, as a second layer.
  for (const bad of ["not-a-hash", "", "   ", "b".repeat(63), "B".repeat(64), 42, null, {}]) {
    const d = await publish({ approvalHash: HASH, companionHash: bad });
    assert.equal(d.allowed, true, `refused on companion ${JSON.stringify(bad)}: ${JSON.stringify(d)}`);
    assert.equal((d as any).effectiveArgs.companionHash, undefined, `companion ${JSON.stringify(bad)} must not pass`);
    assert.equal((d as any).effectiveArgs.approvalHash, HASH, "the primary must still publish");
  }
});

test("a companion EQUAL to the primary is dropped", async () => {
  const d = await publish({ approvalHash: HASH, companionHash: HASH });
  assert.equal(d.allowed, true);
  assert.equal((d as any).effectiveArgs.companionHash, undefined, "the same image twice is not two renderings");
});
