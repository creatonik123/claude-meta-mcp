import { test } from "node:test";
import assert from "node:assert/strict";
import { runGuardedDecision } from "./guarded-action.ts";
import type { GuardConfig, GuardDeps } from "./guard.ts";
import type { AuditEntry, AuditSink } from "./audit.ts";

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
    sameDayDecisionFractionOfDailyCap: 0.8,
    spendSnapshotMaxAgeMinutes: 60,
    monthEndRevisionBufferAud: 300,
  },
  targets: { targetCplAud: 21.5, provisional: true },
  schemaVersion: 1,
};

function makeDeps(modeOff = false): GuardDeps {
  const cfg = modeOff
    ? { ...baseConfig, actionModes: { ...baseConfig.actionModes, pause: "off" as const } }
    : baseConfig;
  return {
    config: cfg,
    now: () => new Date("2026-06-14T10:00:00Z"),
    env: {},
    db: {
      schemaVersion: async () => 1,
      killSwitchRow: async () => false,
      approvalByHash: async () => ({ consumed: false }),
      startOfDayBudget: async () => 100,
      accountStartOfDayTotal: async () => 1000,
      budgetBaseline30d: async () => 1000,
    },
    meta: {
      entityAccountId: async () => "act_1133075730765139",
      currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: null, ownedByCampaignCbo: false }),
      realisedSpend: async () => ({ today: 50, monthToDate: 2000, dateStop: "2026-06-14", complete: true }),
    },
  };
}

function recordingSink(): { sink: AuditSink; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return { sink: { write: async (e) => { entries.push(e); } }, entries };
}

test("allowed action -> decision allowed AND one audit entry (approved_for_execution)", async () => {
  const { sink, entries } = recordingSink();
  const d = await runGuardedDecision("pause", { entityId: "as_1", status: "PAUSED" }, makeDeps(), sink);
  assert.equal(d.allowed, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].result, "approved_for_execution");
  assert.equal(entries[0].ruleTriggered, null);
  assert.equal(entries[0].entityId, "as_1");
});

test("recommend-only (mode off) -> decision refused, audit logs action_mode_off", async () => {
  const { sink, entries } = recordingSink();
  const d = await runGuardedDecision("pause", { entityId: "as_1", status: "PAUSED" }, makeDeps(true), sink);
  assert.equal(d.allowed, false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].result, "refused");
  assert.equal(entries[0].ruleTriggered, "action_mode_off");
});

test("a safety refusal is logged with its code", async () => {
  const { sink, entries } = recordingSink();
  const deps = makeDeps();
  const d = await runGuardedDecision("pause", { entityId: "as_1", status: "PAUSED" }, { ...deps, env: { ADPILOT_KILL_ALL: "1" } }, sink);
  assert.equal(d.allowed, false);
  assert.equal(entries[0].result, "refused");
  assert.equal(entries[0].ruleTriggered, "kill_switch_env");
});

test("exactly one audit entry is written per call", async () => {
  const { sink, entries } = recordingSink();
  await runGuardedDecision("adjust_adset_budget", { entityId: "as_1", dailyBudget: 110 }, makeDeps(), sink);
  assert.equal(entries.length, 1);
});

test("audit-sink failure downgrades an ALLOW to a fail-closed refusal (never an unlogged allow)", async () => {
  const failingSink = { write: async () => { throw new Error("db down"); } };
  const d = await runGuardedDecision("pause", { entityId: "as_1", status: "PAUSED" }, makeDeps(), failingSink);
  assert.equal(d.allowed, false);
  if (d.allowed === false) assert.equal(d.code, "audit_write_failed");
});

test("null args -> refusal is still logged, no throw", async () => {
  const { sink, entries } = recordingSink();
  const d = await runGuardedDecision("pause", null as unknown as Record<string, unknown>, makeDeps(), sink);
  assert.equal(d.allowed, false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].result, "refused");
  assert.equal(entries[0].entityId, null);
});
