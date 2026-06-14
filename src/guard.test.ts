import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  type ActionType,
  type GuardConfig,
  type GuardDeps,
  type Decision,
} from "./guard.ts";

// ---- base config (all action modes 'auto' so we can exercise later checks) ----
const baseConfig: GuardConfig = {
  managedAccountId: "act_1133075730765139",
  deniedAccountIds: ["act_2218833115522041"],
  actionModes: { pause: "auto", adjust_adset_budget: "auto", publish_approved_creative: "auto" },
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
    sameDayDecisionFractionOfDailyCap: 0.8, // same-day decision limit = 272
    spendSnapshotMaxAgeMinutes: 60,
    monthEndRevisionBufferAud: 300,
  },
  targets: { targetCplAud: 21.5, provisional: true },
  schemaVersion: 1,
};

type DeepOverrides = {
  config?: Partial<GuardConfig>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  db?: Partial<GuardDeps["db"]>;
  meta?: Partial<GuardDeps["meta"]>;
};

const FIXED_NOW = () => new Date("2026-06-14T10:00:00Z"); // day = 2026-06-14

function makeDeps(o: DeepOverrides = {}): GuardDeps {
  return {
    config: { ...baseConfig, ...(o.config ?? {}) },
    now: o.now ?? FIXED_NOW,
    env: o.env ?? {},
    db: {
      schemaVersion: async () => 1,
      killSwitchRow: async () => false,
      approvalByHash: async () => ({ consumed: false }),
      startOfDayBudget: async () => 100,
      accountStartOfDayTotal: async () => 1000,
      budgetBaseline30d: async () => 1000, // high default so creep check doesn't fire
      ...(o.db ?? {}),
    },
    meta: {
      entityAccountId: async () => "act_1133075730765139",
      currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: null, ownedByCampaignCbo: false }),
      realisedSpend: async () => ({ today: 50, monthToDate: 2000, dateStop: "2026-06-14", complete: true }),
      ...(o.meta ?? {}),
    },
  };
}

const budget = (b: number) => ({ entityId: "as_1", dailyBudget: b });
const pause = () => ({ entityId: "as_1", status: "PAUSED" });

function expectRefuse(d: Decision, code: string) {
  assert.equal(d.allowed, false, `expected refusal (${code}) but was allowed`);
  if (d.allowed === false) assert.equal(d.code, code);
}
function expectAllow(d: Decision): asserts d is { allowed: true; effectiveArgs: Record<string, unknown> } {
  assert.equal(d.allowed, true, d.allowed === false ? `unexpected refusal: ${d.code} ${d.reason}` : "");
}

// ---- happy paths ----
test("budget: small increase within all limits -> allowed", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps());
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 110);
});

test("budget: 40% request is CLAMPED to +25% (PRD R3 acceptance)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(140), makeDeps());
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 125); // baseline 100 -> max +25%
});

test("pause: valid -> allowed", async () => {
  const d = await evaluate("pause", pause(), makeDeps());
  expectAllow(d);
  assert.equal(d.effectiveArgs.status, "PAUSED");
});

test("publish: valid unconsumed approval -> allowed", async () => {
  const d = await evaluate("publish_approved_creative", { approvalHash: "abc" }, makeDeps());
  expectAllow(d);
});

// ---- kill switch ----
test("kill switch (env flag) -> refuse", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ env: { ADPILOT_KILL_ALL: "1" } }));
  expectRefuse(d, "kill_switch_env");
});

test("kill switch (DB row true) -> refuse", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ db: { killSwitchRow: async () => true } }));
  expectRefuse(d, "kill_switch_db");
});

test("kill switch (DB row missing/null) -> refuse (fail-closed)", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ db: { killSwitchRow: async () => null } }));
  expectRefuse(d, "kill_switch_db");
});

test("kill switch read THROWS -> refuse (fail-closed)", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ db: { killSwitchRow: async () => { throw new Error("db down"); } } }));
  expectRefuse(d, "kill_switch_unreadable");
});

// ---- schema ----
test("schema version mismatch -> refuse", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ db: { schemaVersion: async () => 2 } }));
  expectRefuse(d, "schema_mismatch");
});

// ---- action mode ----
test("action mode off (recommend-only) -> refuse", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ config: { actionModes: { pause: "auto", adjust_adset_budget: "off", publish_approved_creative: "auto" } } }));
  expectRefuse(d, "action_mode_off");
});

// ---- account scope ----
test("scope: wrong account -> refuse", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ meta: { entityAccountId: async () => "act_999" } }));
  expectRefuse(d, "scope_mismatch");
});

test("scope: denied account (APS 2026) -> refuse", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ meta: { entityAccountId: async () => "act_2218833115522041" } }));
  expectRefuse(d, "scope_denied");
});

test("scope: unresolvable owner -> refuse (fail-closed)", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ meta: { entityAccountId: async () => null } }));
  expectRefuse(d, "scope_unknown");
});

// ---- strict args ----
test("pause with status=ACTIVE -> refuse", async () => {
  const d = await evaluate("pause", { entityId: "as_1", status: "ACTIVE" }, makeDeps());
  expectRefuse(d, "args_status");
});

test("pause with an extra field -> refuse", async () => {
  const d = await evaluate("pause", { entityId: "as_1", status: "PAUSED", name: "x" }, makeDeps());
  expectRefuse(d, "args_extra");
});

test("budget with smuggled status field -> refuse", async () => {
  const d = await evaluate("adjust_adset_budget", { entityId: "as_1", dailyBudget: 110, status: "ACTIVE" }, makeDeps());
  expectRefuse(d, "args_extra");
});

test("budget non-integer -> refuse", async () => {
  const d = await evaluate("adjust_adset_budget", { entityId: "as_1", dailyBudget: 110.5 }, makeDeps());
  expectRefuse(d, "args_budget");
});

// ---- budget locus / baseline ----
test("CBO ad-set budget write -> refuse", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { currentBudget: async () => ({ dailyBudget: null, lifetimeBudget: null, ownedByCampaignCbo: true }) } }));
  expectRefuse(d, "budget_cbo");
});

test("missing start-of-day baseline -> refuse (fail-closed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ db: { startOfDayBudget: async () => null } }));
  expectRefuse(d, "baseline_missing");
});

// ---- account aggregate clamp ----
test("account aggregate >+20%/day -> refuse", async () => {
  // one big ad set IS the whole account: baseline 1000, account SoD 1000, request 1300 -> clamp 1250 -> +25% of account -> over +20%
  const d = await evaluate("adjust_adset_budget", { entityId: "as_1", dailyBudget: 1300 }, makeDeps({ db: { startOfDayBudget: async () => 1000, accountStartOfDayTotal: async () => 1000 } }));
  expectRefuse(d, "account_cap");
});

// ---- spend caps (on a real increase) ----
test("clamped increase still over same-day spend limit -> REFUSE (not proceed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { realisedSpend: async () => ({ today: 280, monthToDate: 2000, dateStop: "2026-06-14", complete: true }) } }));
  expectRefuse(d, "daily_spend_cap");
});

test("empty/partial spend page -> refuse (treat as unknown, not zero)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { realisedSpend: async () => ({ today: 0, monthToDate: 0, dateStop: "2026-06-14", complete: false }) } }));
  expectRefuse(d, "spend_indeterminate");
});

test("stale spend snapshot (wrong day) -> refuse", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { realisedSpend: async () => ({ today: 50, monthToDate: 2000, dateStop: "2026-06-13", complete: true }) } }));
  expectRefuse(d, "spend_stale");
});

test("monthly spend cap (with revision buffer) -> refuse", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { realisedSpend: async () => ({ today: 50, monthToDate: 9000, dateStop: "2026-06-14", complete: true }) } }));
  expectRefuse(d, "monthly_spend_cap");
});

// ---- cross-day creep ceiling ----
test("cross-day creep: budget over 2x the 30-day baseline -> refuse", async () => {
  // baseline 100 -> 140 clamps to 125; 30-day baseline 50 -> ceiling 2x = 100; 125 > 100 -> refuse
  const d = await evaluate("adjust_adset_budget", budget(140), makeDeps({ db: { budgetBaseline30d: async () => 50 } }));
  expectRefuse(d, "cross_day_creep");
});

test("cross-day creep: no 30-day baseline yet (null) -> check skipped, still allowed", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ db: { budgetBaseline30d: async () => null } }));
  expectAllow(d);
});

// ---- publish approval ----
test("publish without approval -> refuse", async () => {
  const d = await evaluate("publish_approved_creative", { approvalHash: "abc" }, makeDeps({ db: { approvalByHash: async () => null } }));
  expectRefuse(d, "approval_missing");
});

test("publish with already-consumed approval -> refuse", async () => {
  const d = await evaluate("publish_approved_creative", { approvalHash: "abc" }, makeDeps({ db: { approvalByHash: async () => ({ consumed: true }) } }));
  expectRefuse(d, "approval_consumed");
});

// ---- a decrease is not subject to the spend cap ----
test("budget decrease is allowed even when spend is high", async () => {
  const d = await evaluate("adjust_adset_budget", budget(90), makeDeps({ meta: { realisedSpend: async () => ({ today: 300, monthToDate: 9000, dateStop: "2026-06-14", complete: true }) } }));
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 90);
});

// ---- deep decrease must pass through, NOT be raised back up ----
test("deep budget cut (request 20, baseline 100) passes through unchanged — never raised", async () => {
  const d = await evaluate("adjust_adset_budget", budget(20), makeDeps());
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 20); // not 75
});

// ---- lifetime budget entity refused ----
test("lifetime-budget ad set -> refuse daily-budget write", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { currentBudget: async () => ({ dailyBudget: null, lifetimeBudget: 5000, ownedByCampaignCbo: false }) } }));
  expectRefuse(d, "budget_lifetime");
});

test("lifetimeBudget === 0 (a normal daily-budget ad set) is NOT blocked", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: 0, ownedByCampaignCbo: false }) } }));
  expectAllow(d);
});

test("malformed lifetimeBudget (negative) -> refuse (fail-closed, not allowed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: -1, ownedByCampaignCbo: false }) } }));
  expectRefuse(d, "budget_unknown");
});

test("malformed lifetimeBudget (NaN) -> refuse (fail-closed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: NaN, ownedByCampaignCbo: false }) } }));
  expectRefuse(d, "budget_unknown");
});

test("a DECREASE with a tiny account start-of-day total still passes (decrease never trips account_cap)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(50), makeDeps({ db: { startOfDayBudget: async () => 100, accountStartOfDayTotal: async () => 100 } }));
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 50);
});

// ---- a DECREASE is never blocked by the cross-day creep ceiling ----
test("cross-day creep does NOT block pulling a runaway budget DOWN", async () => {
  // start-of-day 150 (already above 2x the 30d baseline of 50), request 100 (a cut)
  const d = await evaluate("adjust_adset_budget", budget(100), makeDeps({ db: { startOfDayBudget: async () => 150, budgetBaseline30d: async () => 50 } }));
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 100);
});

// ---- cross-day creep inclusive boundary, isolated on an increase ----
test("cross-day creep refuses exactly at 2x the 30d baseline (increase)", async () => {
  // baseline 100, request 120, 30d baseline 60 -> ceiling 120, clamped 120, increase, 120>=120 -> refuse
  const d = await evaluate("adjust_adset_budget", budget(120), makeDeps({ db: { budgetBaseline30d: async () => 60 } }));
  expectRefuse(d, "cross_day_creep");
});

// ---- floor-before-caps actually floors a fractional clamp ----
test("a fractional +25% clamp is floored to an integer before being returned", async () => {
  // baseline 110 -> maxUp 137.5 -> floor 137
  const d = await evaluate("adjust_adset_budget", budget(200), makeDeps({ db: { startOfDayBudget: async () => 110 } }));
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 137);
});

// ---- fail-closed on a non-object args bag (must not throw) ----
test("null args -> refuse args_invalid (no throw)", async () => {
  const d = await evaluate("pause", null as unknown as Record<string, unknown>, makeDeps());
  expectRefuse(d, "args_invalid");
});

// ---- approval row with unknown 'consumed' is treated as used ----
test("publish with malformed approval (consumed undefined) -> refuse", async () => {
  const d = await evaluate("publish_approved_creative", { approvalHash: "abc" }, makeDeps({ db: { approvalByHash: async () => ({}) as { consumed: boolean } } }));
  expectRefuse(d, "approval_consumed");
});

// ---- publish strict args ----
test("publish with a smuggled extra field -> refuse args_extra", async () => {
  const d = await evaluate("publish_approved_creative", { approvalHash: "abc", account_id: "act_2218833115522041" }, makeDeps());
  expectRefuse(d, "args_extra");
});

// ---- account-aggregate boundary is inclusive (refuse at exactly +20%) ----
test("account aggregate exactly at +20% -> refuse (inclusive boundary)", async () => {
  // baseline 1000, account SoD 1000, request 1200 -> clamp to 1250 cap but +20% is the account limit; projected 1000+(min(1200,1250)-1000)=1200 == +20% -> refuse
  const d = await evaluate("adjust_adset_budget", { entityId: "as_1", dailyBudget: 1200 }, makeDeps({ db: { startOfDayBudget: async () => 1000, accountStartOfDayTotal: async () => 1000, budgetBaseline30d: async () => 100000 } }));
  expectRefuse(d, "account_cap");
});

// ---- isolated cross-day creep (within the per-change clamp) ----
test("cross-day creep isolated (request within +25% but over 2x the 30d baseline) -> refuse", async () => {
  // baseline 100, request 110 (within clamp), 30d baseline 50 -> ceiling 100; 110>=100 -> refuse
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ db: { budgetBaseline30d: async () => 50 } }));
  expectRefuse(d, "cross_day_creep");
});

// ---- kill-switch env decoder edge values ----
test('kill env "0" is treated as NOT frozen', async () => {
  const d = await evaluate("pause", pause(), makeDeps({ env: { ADPILOT_KILL_ALL: "0" } }));
  expectAllow(d);
});

test('kill env "off" is treated as FROZEN (any other value = frozen)', async () => {
  const d = await evaluate("pause", pause(), makeDeps({ env: { ADPILOT_KILL_ALL: "off" } }));
  expectRefuse(d, "kill_switch_env");
});

// ---- fail-closed on additional reads that throw ----
test("schemaVersion read throws -> refuse (fail-closed)", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ db: { schemaVersion: async () => { throw new Error("x"); } } }));
  expectRefuse(d, "schema_unreadable");
});

test("realisedSpend throws on an increase -> refuse (fail-closed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { realisedSpend: async () => { throw new Error("meta down"); } } }));
  expectRefuse(d, "spend_unreadable");
});

// ---- increase WITH high spend pairs with the decrease case ----
test("budget INCREASE with high today-spend -> daily_spend_cap", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { realisedSpend: async () => ({ today: 300, monthToDate: 2000, dateStop: "2026-06-14", complete: true }) } }));
  expectRefuse(d, "daily_spend_cap");
});
