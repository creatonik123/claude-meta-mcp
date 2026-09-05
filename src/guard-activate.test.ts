/**
 * ACTIVATE — the mirror of pause, for exactly one purpose: switching on an ad the guard itself just
 * created PAUSED through publish_approved_creative (creative rotation §4a). Nothing else may be
 * activated: not a hand-made ad, not an ad set, not an ad in another campaign, and never with any
 * status but ACTIVE.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type GuardDeps, type GuardConfig } from "./guard.ts";

const baseConfig: GuardConfig = {
  managedAccountId: "act_2218833115522041",
  allowedCampaignIds: ["120200123"],
  deniedAccountIds: ["act_1133075730765139"],
  actionModes: { pause: "auto", adjust_adset_budget: "auto", publish_approved_creative: "auto", activate: "auto" },
  accountTimezone: "Australia/North",
  killSwitchEnvFlag: "ADPILOT_KILL_ALL",
  budgetClamp: { maxSingleChangePct: 25, maxAccountChangePerDayPct: 20, blockLifetimeBudgetWrites: true, blockCboAdsetBudgetWrites: true, crossDayMaxMultipleVs30dBaseline: 2.0 },
  spendCaps: { dailyAud: 340, monthlyAud: 9250, sameDayDecisionFractionOfDailyCap: 0.8, monthEndRevisionBufferAud: 300 },
  targets: { targetCplAud: 25, provisional: false },
  schemaVersion: 1,
};
const NOW = () => new Date("2026-09-06T21:02:00Z");
const PUBLISHED_AT = new Date("2026-09-05T21:03:00Z"); // created by our publish ~24h earlier

function deps(o: { config?: Partial<GuardConfig>; db?: Partial<GuardDeps["db"]>; meta?: Partial<GuardDeps["meta"]>; env?: Record<string, string> } = {}): GuardDeps {
  return {
    config: { ...baseConfig, ...(o.config ?? {}) },
    now: NOW,
    env: o.env ?? {},
    db: {
      schemaVersion: async () => 1,
      killSwitchRow: async () => false,
      approvalByHash: async () => ({ consumed: false }),
      startOfDayBudget: async () => 100,
      accountStartOfDayTotal: async () => 1000,
      budgetBaseline30d: async () => 1000,
      publishedAdConsumption: async () => ({ consumedAt: PUBLISHED_AT }),
      ...(o.db ?? {}),
    },
    meta: {
      entityAccountId: async () => "act_2218833115522041",
      entityCampaignId: async () => "120200123",
      currentBudget: async () => null,
      realisedSpend: async () => null,
      accountActiveDailyBudgetTotal: async () => null,
      ...(o.meta ?? {}),
    },
  };
}
const args = (over: Record<string, unknown> = {}) => ({ entityId: "ad_new_1", status: "ACTIVE", ...over });

test("activate: an ad the guard published, in the allowed campaign, mode auto -> allowed with status ACTIVE", async () => {
  const d = await evaluate("activate", args(), deps());
  assert.equal(d.allowed, true);
  if (d.allowed) assert.deepEqual(d.effectiveArgs, { entityId: "ad_new_1", status: "ACTIVE" });
});
test("activate: the ad was NOT created by our publish -> refuse not_our_ad (a hand-made ad is never switched on by the agent)", async () => {
  const d = await evaluate("activate", args(), deps({ db: { publishedAdConsumption: async () => null } }));
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.code, "not_our_ad");
});
test("activate: the publish record is unreadable -> refuse (fail-closed), never allowed", async () => {
  const d = await evaluate("activate", args(), deps({ db: { publishedAdConsumption: async () => { throw new Error("db down"); } } }));
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.code, "publish_record_unreadable");
});
test("activate: published too long ago (> 7 days) -> refuse publish_too_old; a forgotten paused ad is not switched on months later", async () => {
  const d = await evaluate("activate", args(), deps({ db: { publishedAdConsumption: async () => ({ consumedAt: new Date("2026-08-01T00:00:00Z") }) } }));
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.code, "publish_too_old");
});
test("activate: mode off -> refuse action_mode_off", async () => {
  const d = await evaluate("activate", args(), deps({ config: { actionModes: { ...baseConfig.actionModes, activate: "off" } } }));
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.code, "action_mode_off");
});
test("activate: status other than ACTIVE -> refuse args_status; extra field -> refuse args_extra; missing entityId -> args_entity", async () => {
  const a = await evaluate("activate", args({ status: "PAUSED" }), deps());
  assert.equal(!a.allowed && a.code, "args_status");
  const b = await evaluate("activate", args({ name: "x" }), deps());
  assert.equal(!b.allowed && b.code, "args_extra");
  const c = await evaluate("activate", { status: "ACTIVE" }, deps());
  assert.equal(!c.allowed && c.code, "args_entity");
});
test("activate: campaign scope applies exactly as for pause — another campaign refuses", async () => {
  const d = await evaluate("activate", args(), deps({ meta: { entityCampaignId: async () => "999" } }));
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.code, "campaign_scope_mismatch");
});
test("activate: denied production account refuses", async () => {
  const d = await evaluate("activate", args(), deps({ meta: { entityAccountId: async () => "act_1133075730765139" } }));
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.code, "scope_denied");
});
test("activate: kill switch refuses before anything is read", async () => {
  let read = false;
  const d = await evaluate("activate", args(), deps({ env: { ADPILOT_KILL_ALL: "1" }, db: { publishedAdConsumption: async () => { read = true; return { consumedAt: PUBLISHED_AT }; } } }));
  assert.equal(d.allowed, false);
  assert.equal(read, false);
});
