import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type GuardConfig, type GuardDeps } from "./guard.ts";

// Publish is the only action that CREATES something. Until now the guard refused every publish with
// `campaign_scope_unverifiable`, because publish args carry only an approvalHash and there was no
// entity from which to resolve a campaign — a valid approval alone must never authorise a write whose
// destination cannot be proven in scope.
//
// This closes that gap the way the guard's own comment specifies: the immutable approval record
// carries its TARGET ENTITY, and that entity goes through the SAME account + campaign checks that
// pause and budget already pass. Two properties matter most:
//
//  1. The target comes from the APPROVAL RECORD, never from the caller's args. If the caller could
//     name the destination, an approval for one ad set could be published into another — including a
//     campaign nobody approved. The approval record is what a human signed off; args are not.
//  2. It is the SAME check, not a parallel one. A second copy of the campaign-isolation logic would
//     drift from the first, and the whole point of the guard is that there is exactly one authority.

const baseConfig: GuardConfig = {
  managedAccountId: "act_2218833115522041",
  allowedCampaignIds: ["120200123"],
  deniedAccountIds: ["act_1133075730765139"],
  actionModes: { pause: "auto", adjust_adset_budget: "auto", publish_approved_creative: "auto", activate: "auto" },
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

type Overrides = {
  config?: Partial<GuardConfig>;
  db?: Partial<GuardDeps["db"]>;
  meta?: Partial<GuardDeps["meta"]>;
};

function makeDeps(o: Overrides = {}): GuardDeps {
  return {
    config: { ...baseConfig, ...(o.config ?? {}) },
    now: () => new Date("2026-06-14T10:00:00Z"),
    env: {},
    db: {
      schemaVersion: async () => 1,
      killSwitchRow: async () => false,
      // An approval that IS bound to a target ad set — the shape this change introduces.
      approvalByHash: async () => ({ consumed: false, targetEntityId: TARGET_ADSET }),
      publishedAdConsumption: async () => null,      startOfDayBudget: async () => 100,
      accountStartOfDayTotal: async () => 1000,
      budgetBaseline30d: async () => 1000,
      ...(o.db ?? {}),
    },
    meta: {
      entityAccountId: async () => "act_2218833115522041",
      entityCampaignId: async () => "120200123",
      currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: null, ownedByCampaignCbo: false, effectiveStatus: "ACTIVE" }),
      realisedSpend: async () => ({ today: 50, monthToDate: 2000, dateStop: "2026-06-14", complete: true }),
      accountActiveDailyBudgetTotal: async () => ({ total: 1000, entityCounted: 100 }),
      ...(o.meta ?? {}),
    },
  };
}

const publish = (deps: GuardDeps, args: Record<string, unknown> = { approvalHash: HASH }) =>
  evaluate("publish_approved_creative", args, deps);

test("an approval bound to an in-scope ad set is ALLOWED", async () => {
  const d = await publish(makeDeps());
  assert.equal(d.allowed, true, `publish was refused: ${JSON.stringify(d)}`);
});

test("the target is resolved through the SAME account+campaign checks as pause/budget", async () => {
  // Proof that the real checks ran: the guard must have asked Meta who owns the target and which
  // campaign it is in — using the ad set id from the APPROVAL, not anything in args.
  const asked: string[] = [];
  const d = await publish(
    makeDeps({
      meta: {
        entityAccountId: async (id: string) => { asked.push(`account:${id}`); return "act_2218833115522041"; },
        entityCampaignId: async (id: string) => { asked.push(`campaign:${id}`); return "120200123"; },
      },
    })
  );
  assert.equal(d.allowed, true);
  assert.ok(asked.includes(`account:${TARGET_ADSET}`), `account check never ran on the approval's target: ${asked.join(",")}`);
  assert.ok(asked.includes(`campaign:${TARGET_ADSET}`), `campaign check never ran on the approval's target: ${asked.join(",")}`);
});

test("an approval with NO target refuses — an unprovable destination is never authorised", async () => {
  for (const bad of [undefined, null, "", "   "]) {
    const d = await publish(makeDeps({ db: { approvalByHash: async () => ({ consumed: false, targetEntityId: bad } as never) } }));
    assert.equal(d.allowed, false, `targetEntityId=${JSON.stringify(bad)} must not be publishable`);
    assert.equal(d.code, "approval_no_target");
  }
});

test("a target in the DENIED (production) account refuses", async () => {
  const d = await publish(makeDeps({ meta: { entityAccountId: async () => "act_1133075730765139" } }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, "scope_denied");
});

test("a target in some OTHER account refuses", async () => {
  const d = await publish(makeDeps({ meta: { entityAccountId: async () => "act_5555555555" } }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, "scope_mismatch");
});

test("a target in a campaign that is NOT allowlisted refuses", async () => {
  const d = await publish(makeDeps({ meta: { entityCampaignId: async () => "999888777" } }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, "campaign_scope_mismatch");
});

test("an EMPTY campaign allowlist refuses (never infer permission from missing config)", async () => {
  const d = await publish(makeDeps({ config: { allowedCampaignIds: [] } }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, "campaign_scope_unset");
});

test("an unreadable owner or campaign refuses (fail closed)", async () => {
  const owner = await publish(makeDeps({ meta: { entityAccountId: async () => { throw new Error("meta down"); } } }));
  assert.equal(owner.allowed, false);
  assert.equal(owner.code, "owner_unreadable");

  const camp = await publish(makeDeps({ meta: { entityCampaignId: async () => { throw new Error("meta down"); } } }));
  assert.equal(camp.allowed, false);
  assert.equal(camp.code, "campaign_unreadable");
});

test("an unresolvable owner/campaign refuses rather than defaulting", async () => {
  const owner = await publish(makeDeps({ meta: { entityAccountId: async () => null as never } }));
  assert.equal(owner.allowed, false);
  assert.equal(owner.code, "scope_unknown");

  const camp = await publish(makeDeps({ meta: { entityCampaignId: async () => null as never } }));
  assert.equal(camp.allowed, false);
  assert.equal(camp.code, "campaign_scope_unknown");
});

test("args may NOT name the destination — the caller cannot choose where creative lands", async () => {
  // The strict arg allow-list must keep rejecting anything beyond approvalHash. If a caller could
  // pass targetAdsetId, an approval for one ad set could be published into another.
  const d = await publish(makeDeps(), { approvalHash: HASH, targetAdsetId: "120200123456" });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "args_extra");
});

test("a target named in args is IGNORED even when the approval is valid", async () => {
  // Belt and braces on the property above: whatever args say, the checks run on the approval's own
  // target. Here args point at an allowed campaign while the approval's target is out of scope —
  // the out-of-scope approval must win.
  const d = await publish(
    makeDeps({ meta: { entityCampaignId: async (id: string) => (id === TARGET_ADSET ? "999888777" : "120200123") } }),
    { approvalHash: HASH }
  );
  assert.equal(d.allowed, false);
  assert.equal(d.code, "campaign_scope_mismatch");
});

test("a consumed approval still refuses BEFORE any scope work", async () => {
  const d = await publish(makeDeps({ db: { approvalByHash: async () => ({ consumed: true, targetEntityId: TARGET_ADSET }) } }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, "approval_consumed");
});

test("a missing approval still refuses", async () => {
  const d = await publish(makeDeps({ db: { approvalByHash: async () => null } }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, "approval_missing");
});

test("an unreadable approval still refuses", async () => {
  const d = await publish(makeDeps({ db: { approvalByHash: async () => { throw new Error("db down"); } } }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, "approval_unreadable");
});

test("publish in recommend-only mode is refused regardless of scope", async () => {
  const d = await publish(makeDeps({ config: { actionModes: { pause: "auto", adjust_adset_budget: "auto", publish_approved_creative: "off", activate: "off" } } }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, "action_mode_off");
});

test("the allowed decision does NOT hand Meta a caller-supplied destination", async () => {
  const d = await publish(makeDeps());
  assert.equal(d.allowed, true);
  const eff = JSON.stringify((d as { effectiveArgs?: unknown }).effectiveArgs ?? {});
  assert.ok(!eff.includes("120200123456"), "no caller-supplied id may reach the executor");
});
