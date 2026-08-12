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
    sameDayDecisionFractionOfDailyCap: 0.8, // same-day decision limit = 272
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
      entityAccountId: async () => "act_2218833115522041",
      entityCampaignId: async () => "120200123",
      currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }),
      realisedSpend: async () => ({ today: 50, monthToDate: 2000, dateStop: "2026-06-14", complete: true }),
      accountActiveDailyBudgetTotal: async () => ({ total: 1000, entityCounted: 100 }), // total matches accountStartOfDayTotal (no headroom consumed); target counted at its live 100
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

// A valid unconsumed approval clears the approval checks but is NOT sufficient on its own: the
// campaign-scope gate is the last word, and a publish target cannot be proven in scope (see the
// publish branch). Asserting the reason proves the approval logic still ran and passed — a regression
// that broke it would surface as approval_missing / approval_consumed / approval_unreadable instead.
test("publish: valid unconsumed approval clears approval checks, then campaign scope refuses", async () => {
  // The invariant is unchanged: an approval ALONE never authorises a publish, because the destination
  // must be provably in scope. Only the refusal code moved — the default fixture's approval carries no
  // targetEntityId, so the destination is unprovable and the guard says so precisely. An approval that
  // IS bound to an in-scope ad set is exercised in guard-publish-scope.test.ts.
  const d = await evaluate("publish_approved_creative", { approvalHash: "abc" }, makeDeps());
  expectRefuse(d, "approval_no_target");
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

test("scope: denied account (the main production account) -> refuse", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ meta: { entityAccountId: async () => "act_1133075730765139" } }));
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

test("budget zero or negative -> refuse (positivity is the only barrier: 0 skips every ceiling)", async () => {
  const zero = await evaluate("adjust_adset_budget", { entityId: "as_1", dailyBudget: 0 }, makeDeps());
  expectRefuse(zero, "args_budget");
  const neg = await evaluate("adjust_adset_budget", { entityId: "as_1", dailyBudget: -5 }, makeDeps());
  expectRefuse(neg, "args_budget");
});

test("budget non-integer -> refuse", async () => {
  const d = await evaluate("adjust_adset_budget", { entityId: "as_1", dailyBudget: 110.5 }, makeDeps());
  expectRefuse(d, "args_budget");
});

// ---- budget locus / baseline ----
test("CBO ad-set budget write -> refuse", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { currentBudget: async () => ({ dailyBudget: null, lifetimeBudget: null, ownedByCampaignCbo: true, effectiveStatus: "ACTIVE" }) } }));
  expectRefuse(d, "budget_cbo");
});

test("missing start-of-day baseline -> refuse (fail-closed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ db: { startOfDayBudget: async () => null } }));
  expectRefuse(d, "baseline_missing");
});

// ---- account aggregate clamp ----
test("account aggregate >+20%/day -> refuse", async () => {
  // one big ad set IS the whole account: baseline 1000, account SoD 1000, request 1300 -> clamp 1250 -> +25% of account -> over +20%
  const d = await evaluate("adjust_adset_budget", { entityId: "as_1", dailyBudget: 1300 }, makeDeps({
    db: { startOfDayBudget: async () => 1000, accountStartOfDayTotal: async () => 1000 },
    meta: {
      currentBudget: async () => ({ dailyBudget: 1000, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }),
      accountActiveDailyBudgetTotal: async () => ({ total: 1000, entityCounted: 1000 }),
    },
  }));
  expectRefuse(d, "account_cap");
});

// ---- account cap is CUMULATIVE via the live total ----
test("increase refused when earlier same-day increases already consumed the account headroom", async () => {
  // SoD total 1000 (+20% ceiling 1200). Other ad sets were already raised today:
  // live total 1195. This entity: baseline+current 100, requesting 110 (well within
  // its own +25%) -> projected live total 1205 >= 1200 -> refuse.
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({
    meta: { accountActiveDailyBudgetTotal: async () => ({ total: 1195, entityCounted: 100 }) },
  }));
  expectRefuse(d, "account_cap");
});

test("live account total unreadable (throws) -> refuse (fail-closed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({
    meta: { accountActiveDailyBudgetTotal: async () => { throw new Error("meta down"); } },
  }));
  expectRefuse(d, "acct_live_unreadable");
});

test("live account total null -> refuse (fail-closed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({
    meta: { accountActiveDailyBudgetTotal: async () => null },
  }));
  expectRefuse(d, "acct_live_missing");
});

// ---- the projection swap uses the entity's contribution from the SAME walk ----
test("account cap: entity paused mid-decision (absent from the live walk) still projects fully — no phantom headroom", async () => {
  // SoD total 1000 (ceiling 1200). Live walk total 1080 WITHOUT the target (a
  // human paused it between the entity read and the walk): entityCounted 0.
  // Request 125 -> projected 1080 - 0 + 125 = 1205 >= 1200 -> refuse.
  // Subtracting the stale entity read (100) would yield 1105 and allow it.
  const d = await evaluate("adjust_adset_budget", budget(125), makeDeps({
    meta: { accountActiveDailyBudgetTotal: async () => ({ total: 1080, entityCounted: 0 }) },
  }));
  expectRefuse(d, "account_cap");
});

test("account cap: malformed live walk (entityCounted above total) -> refuse (fail-closed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({
    meta: { accountActiveDailyBudgetTotal: async () => ({ total: 100, entityCounted: 200 }) },
  }));
  expectRefuse(d, "acct_live_missing");
});

test("a DECREASE is never blocked by the account cap, even with a huge live total", async () => {
  const d = await evaluate("adjust_adset_budget", budget(90), makeDeps({
    meta: { accountActiveDailyBudgetTotal: async () => ({ total: 999999, entityCounted: 100 }) },
  }));
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 90);
});

// ---- lower-then-restore: raising the LIVE budget faces the caps even at/below the SoD baseline ----
test("restore-raise (at the SoD baseline but above the live budget) still faces the account cap", async () => {
  // baseline 100, live current 10 (lowered earlier), request 100 -> not an
  // 'increase' vs baseline, but it RAISES live capacity by 90. Other ad sets
  // already consumed the headroom: live total 1150, SoD 1000, ceiling 1200 ->
  // projected 1150 - 10 + 100 = 1240 >= 1200 -> refuse.
  const d = await evaluate("adjust_adset_budget", budget(100), makeDeps({
    meta: {
      currentBudget: async () => ({ dailyBudget: 10, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }),
      accountActiveDailyBudgetTotal: async () => ({ total: 1150, entityCounted: 10 }),
    },
  }));
  expectRefuse(d, "account_cap");
});

test("restore-raise also faces the realised-spend caps", async () => {
  const d = await evaluate("adjust_adset_budget", budget(100), makeDeps({
    meta: {
      currentBudget: async () => ({ dailyBudget: 10, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }),
      realisedSpend: async () => ({ today: 300, monthToDate: 2000, dateStop: "2026-06-14", complete: true }),
    },
  }));
  expectRefuse(d, "daily_spend_cap");
});

test("a true decrease vs the LIVE budget skips the account/spend ceilings", async () => {
  // current 100, request 90: lowers live capacity even though other totals are hot
  const d = await evaluate("adjust_adset_budget", budget(90), makeDeps({
    meta: {
      accountActiveDailyBudgetTotal: async () => ({ total: 999999, entityCounted: 100 }),
      realisedSpend: async () => ({ today: 339, monthToDate: 9200, dateStop: "2026-06-14", complete: true }),
    },
  }));
  expectAllow(d);
});

// ---- budget writes only on ACTIVE (delivering) ad sets ----
test("budget write on a PAUSED ad set -> refuse (phantom headroom: it is outside the live total)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({
    meta: { currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "PAUSED" }) },
  }));
  expectRefuse(d, "budget_entity_not_active");
});

test("budget write with an unreadable effective_status -> refuse (fail-closed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({
    meta: { currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: null }) },
  }));
  expectRefuse(d, "budget_entity_not_active");
});

// ---- ceilings gate on LIVE capacity: walking a hot budget DOWN is never blocked ----
test("a live DECREASE above the frozen baseline skips account/spend ceilings (walk-back allowed)", async () => {
  // baseline 100; a human raised the ad set to 150 mid-day and the account is
  // over its ceiling (live 1500 vs SoD 1000). Setting 120 LOWERS live capacity
  // and must pass — blocking it would block the remediation itself.
  const d = await evaluate("adjust_adset_budget", budget(120), makeDeps({
    meta: {
      currentBudget: async () => ({ dailyBudget: 150, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }),
      accountActiveDailyBudgetTotal: async () => ({ total: 1500, entityCounted: 150 }),
      realisedSpend: async () => ({ today: 339, monthToDate: 9200, dateStop: "2026-06-14", complete: true }),
    },
  }));
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 120);
});

// ---- pins the `- entityCurrent` swap in the projection (allow-case) ----
test("account-cap projection swaps the entity's walk-counted budget for the clamped value", async () => {
  // live total 1150 INCLUDES this entity at 100 (entityCounted from the same
  // walk); raising to 110 projects 1150 - 100 + 110 = 1160 < 1200 -> ALLOW.
  // (Double-counting the entity — dropping the subtraction — would project
  // 1260 and wrongly refuse.)
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({
    meta: { accountActiveDailyBudgetTotal: async () => ({ total: 1150, entityCounted: 100 }) },
  }));
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 110);
});

// ---- spend caps (on a real increase) ----
test("clamped increase still over same-day spend limit -> REFUSE (not proceed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { realisedSpend: async () => ({ today: 280, monthToDate: 2000, dateStop: "2026-06-14", complete: true }) } }));
  expectRefuse(d, "daily_spend_cap");
});

test("daily spend cap refuses EXACTLY at the same-day decision limit (inclusive boundary)", async () => {
  // dailyAud 340 x fraction 0.8 = 272. At exactly 272 the >= must refuse; a
  // '>' regression would let the boundary case through.
  const at = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { realisedSpend: async () => ({ today: 272, monthToDate: 2000, dateStop: "2026-06-14", complete: true }) } }));
  expectRefuse(at, "daily_spend_cap");
  const under = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { realisedSpend: async () => ({ today: 271.99, monthToDate: 2000, dateStop: "2026-06-14", complete: true }) } }));
  expectAllow(under);
});

test("monthly spend cap refuses EXACTLY at the cap minus the revision buffer (inclusive boundary)", async () => {
  // monthlyAud 9250 - buffer 300 = 8950. At exactly 8950 the >= must refuse.
  const at = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { realisedSpend: async () => ({ today: 50, monthToDate: 8950, dateStop: "2026-06-14", complete: true }) } }));
  expectRefuse(at, "monthly_spend_cap");
  const under = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { realisedSpend: async () => ({ today: 50, monthToDate: 8949.99, dateStop: "2026-06-14", complete: true }) } }));
  expectAllow(under);
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
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { currentBudget: async () => ({ dailyBudget: null, lifetimeBudget: 5000, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }) } }));
  expectRefuse(d, "budget_lifetime");
});

test("lifetimeBudget === 0 (a normal daily-budget ad set) is NOT blocked", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: 0, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }) } }));
  expectAllow(d);
});

test("malformed lifetimeBudget (negative) -> refuse (fail-closed, not allowed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: -1, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }) } }));
  expectRefuse(d, "budget_unknown");
});

test("malformed lifetimeBudget (NaN) -> refuse (fail-closed)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: NaN, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }) } }));
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

// The lower-then-restore hole: a value at/below the frozen SoD baseline can
// still RAISE live capacity and must face the creep ceiling.
test("restore after a human mid-day cut is creep-checked (cannot re-raise above the ceiling)", async () => {
  // SoD 150, human cut live to 60, 30d baseline 50 -> ceiling 100. Restoring
  // 150 raises live capacity 60 -> 150 and must refuse, even though 150 does
  // not exceed the frozen SoD baseline.
  const d = await evaluate("adjust_adset_budget", budget(150), makeDeps({
    db: { startOfDayBudget: async () => 150, budgetBaseline30d: async () => 50 },
    meta: { currentBudget: async () => ({ dailyBudget: 60, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }) },
  }));
  expectRefuse(d, "cross_day_creep");
});

test("a live walk-DOWN to a value above the creep ceiling is allowed (reducing spend is never blocked)", async () => {
  // SoD 100, human raised live to 150, 30d baseline 55 -> ceiling 110. Walking
  // down to 115 lowers live capacity, so the ceiling must not fire.
  const d = await evaluate("adjust_adset_budget", budget(115), makeDeps({
    db: { budgetBaseline30d: async () => 55 },
    meta: { currentBudget: async () => ({ dailyBudget: 150, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }) },
  }));
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 115);
});

test("the 30d-baseline read is NOT made for a walk-down above the SoD baseline (a DB blip cannot block it)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(115), makeDeps({
    db: { budgetBaseline30d: async () => { throw new Error("db blip"); } },
    meta: { currentBudget: async () => ({ dailyBudget: 150, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }) },
  }));
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 115);
});

test("a FAILING 30d-baseline read does not block a decrease (read runs only when live capacity rises)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(90), makeDeps({
    db: { budgetBaseline30d: async () => { throw new Error("db blip"); } },
  }));
  expectAllow(d);
  assert.equal(d.effectiveArgs.dailyBudget, 90);
});

test("a FAILING 30d-baseline read still refuses an increase (fail-closed where it matters)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({
    db: { budgetBaseline30d: async () => { throw new Error("db blip"); } },
  }));
  expectRefuse(d, "b30_unreadable");
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
  const d = await evaluate("publish_approved_creative", { approvalHash: "abc", account_id: "act_1133075730765139" }, makeDeps());
  expectRefuse(d, "args_extra");
});

// ---- account-aggregate boundary is inclusive (refuse at exactly +20%) ----
test("account aggregate exactly at +20% -> refuse (inclusive boundary)", async () => {
  // baseline 1000, account SoD 1000, request 1200 -> clamp to 1250 cap but +20% is the account limit; projected 1000-1000+min(1200,1250)=1200 == +20% -> refuse
  const d = await evaluate("adjust_adset_budget", { entityId: "as_1", dailyBudget: 1200 }, makeDeps({
    db: { startOfDayBudget: async () => 1000, accountStartOfDayTotal: async () => 1000, budgetBaseline30d: async () => 100000 },
    meta: {
      currentBudget: async () => ({ dailyBudget: 1000, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }),
      accountActiveDailyBudgetTotal: async () => ({ total: 1000, entityCounted: 1000 }),
    },
  }));
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

// ---- account timezone: day boundaries follow the account tz, not UTC ----
test("budget baseline + spend use the ACCOUNT-tz day, not UTC", async () => {
  // 2026-06-14T16:00Z = 2026-06-15 02:00 in Australia/Sydney -> account day is the 15th
  let seenSodDay: string | null = null;
  let seenAcctDay: string | null = null;
  let seenB30Day: string | null = null;
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({
    now: () => new Date("2026-06-14T16:00:00Z"),
    db: {
      startOfDayBudget: async (_e: string, day: string) => { seenSodDay = day; return 100; },
      accountStartOfDayTotal: async (day: string) => { seenAcctDay = day; return 1000; },
      budgetBaseline30d: async (_e: string, day: string) => { seenB30Day = day; return 1000; },
    },
    meta: {
      realisedSpend: async () => ({ today: 50, monthToDate: 2000, dateStop: "2026-06-15", complete: true }),
    },
  }));
  expectAllow(d);
  assert.equal(seenSodDay, "2026-06-15");
  assert.equal(seenAcctDay, "2026-06-15");
  assert.equal(seenB30Day, "2026-06-15");
});

test("invalid account timezone fails closed (budget)", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ config: { accountTimezone: "Mars/Phobos" } }));
  expectRefuse(d, "tz_invalid");
});

// ---- campaign scope (isolation: a trial runs on ONE campaign; the rest of the account is untouchable) ----
test("campaign scope: entity in an allowed campaign -> allowed", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ meta: { entityCampaignId: async () => "120200123" } }));
  assert.equal(d.allowed, true);
});

test("campaign scope: entity in ANOTHER campaign -> refuse", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ meta: { entityCampaignId: async () => "120200999" } }));
  expectRefuse(d, "campaign_scope_mismatch");
});

test("campaign scope: budget writes are scoped too, not just pause", async () => {
  const d = await evaluate("adjust_adset_budget", budget(110), makeDeps({ meta: { entityCampaignId: async () => "120200999" } }));
  expectRefuse(d, "campaign_scope_mismatch");
});

test("campaign scope: empty allowlist -> refuse every entity write (shipping default)", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ config: { allowedCampaignIds: [] } }));
  expectRefuse(d, "campaign_scope_unset");
});

test("campaign scope: allowlist absent -> refuse (misconfiguration never opens the account)", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ config: { allowedCampaignIds: undefined } }));
  expectRefuse(d, "campaign_scope_unset");
});

test("campaign scope: unresolvable campaign -> refuse (fail-closed)", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ meta: { entityCampaignId: async () => null } }));
  expectRefuse(d, "campaign_scope_unknown");
});

test("campaign scope: campaign lookup throws -> refuse (fail-closed)", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ meta: { entityCampaignId: async () => { throw new Error("graph down"); } } }));
  expectRefuse(d, "campaign_unreadable");
});

test("campaign scope: exact id match only — a neighbouring id does not pass", async () => {
  const d = await evaluate("pause", pause(), makeDeps({ meta: { entityCampaignId: async () => "12020012" } }));
  expectRefuse(d, "campaign_scope_mismatch");
});

test("campaign scope: the SHIPPED config allows exactly the smoke-test sandbox campaign", async () => {
  // Stage 2: the one allowed campaign is the PAUSED sandbox in APS 2026 (52623318982420),
  // created 2026-08-12 for the zero-spend smoke test. Nothing else is writable.
  const shipped = (await import("./load-config.ts")).loadGuardConfig();
  assert.deepEqual(shipped.allowedCampaignIds, ["52623318982420"]);
});

// ---- publish is campaign-scoped too: its target cannot be proven in scope, so it fails closed ----
test("publish: an approval with no recorded target is refused (destination unprovable)", async () => {
  // Campaign isolation now applies to publish via the approval's own target entity. An approval
  // without one cannot be checked, so it refuses — permission is never inferred from a missing target.
  const d = await evaluate("publish_approved_creative", { approvalHash: "abc" }, makeDeps());
  expectRefuse(d, "approval_no_target");
});

test("publish: an unconsumed approval is NOT sufficient to bypass campaign scope", async () => {
  const d = await evaluate("publish_approved_creative", { approvalHash: "abc" }, makeDeps({ db: { approvalByHash: async () => ({ consumed: false }) } }));
  assert.equal(d.allowed, false);
});
