import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGuardConfig, parseGuardConfig, assertShipInvariants, FORBIDDEN_ACCOUNT } from "./load-config.ts";

test("the on-disk guard.config.json parses and validates", () => {
  const c = loadGuardConfig();
  assert.equal(c.managedAccountId, "act_2218833115522041");
  assert.equal(c.schemaVersion, 1);
  assert.ok(c.deniedAccountIds.includes("act_1133075730765139"));
});

test("the shipped config satisfies the ship invariants for the current stage", () => {
  const c = loadGuardConfig();
  assert.doesNotThrow(() => assertShipInvariants(c));
  // Stage 5 (2026-08-17): all three modes armed against exactly one campaign — now the live trial
  // campaign `AdPilot Trial | ABO | Aug 2026` (52623496198420) rather than the retired smoke
  // sandbox. The app side holds the same single id (execution-config.js), and the app's own
  // driver + per-type modes remain OFF, so this arms scope, not execution.
  assert.equal(c.actionModes.pause, "auto");
  assert.equal(c.actionModes.adjust_adset_budget, "auto");
  assert.equal(c.actionModes.publish_approved_creative, "auto");
  assert.deepEqual(c.allowedCampaignIds, ["52623496198420"]);
  // A$25 was signed off as the real CPL target on 2026-08-13, so it is no longer provisional.
  // The flag exists so nobody mistakes a placeholder for an agreed number; leaving it true after
  // sign-off would misreport the config's own status.
  assert.equal(c.targets.targetCplAud, 25);
  assert.equal(c.targets.provisional, false);
});

test("a non-IANA accountTimezone is refused at config load (boot), not at decision time", () => {
  const c = loadGuardConfig();
  assert.throws(() => parseGuardConfig({ ...c, accountTimezone: "Mars/Phobos" }), /IANA/);
  assert.throws(() => parseGuardConfig({ ...c, accountTimezone: "" }));
});

test("assertShipInvariants throws on a mode value outside off/auto", () => {
  const c = loadGuardConfig();
  const tampered = { ...c, actionModes: { ...c.actionModes, pause: "confirm" as const } };
  assert.throws(() => assertShipInvariants(tampered), /recommend-only|invalid/);
});

test("assertShipInvariants throws if the forbidden account is removed from the deny list", () => {
  const c = loadGuardConfig();
  const tampered = { ...c, deniedAccountIds: c.deniedAccountIds.filter((a) => a !== "act_1133075730765139") };
  assert.throws(() => assertShipInvariants(tampered), /deniedAccountIds/);
});

// The deny-list check alone cannot see a re-inversion. Point managedAccountId back at production
// while leaving it in deniedAccountIds and boot still passes — writes then refuse only because
// guard.ts evaluates the deny check before the mismatch check. That is fail-closed by ordering,
// not by design, and reordering those two blocks would silently re-open the production account.
test("assertShipInvariants throws if the managed account is ALSO on the deny list", () => {
  const c = loadGuardConfig();
  const tampered = { ...c, deniedAccountIds: [...c.deniedAccountIds, c.managedAccountId] };
  assert.throws(() => assertShipInvariants(tampered), /managedAccountId/);
});

test("assertShipInvariants throws if the managed account is the forbidden production account", () => {
  const c = loadGuardConfig();
  const tampered = { ...c, managedAccountId: FORBIDDEN_ACCOUNT };
  assert.throws(() => assertShipInvariants(tampered), /forbidden/i);
});

test("the shipped timezone is the managed account's own (Australia/North), not Sydney", () => {
  assert.equal(loadGuardConfig().accountTimezone, "Australia/North");
});

test("ship invariant: the allowlist may not exceed ONE campaign (the trial is a single campaign)", async () => {
  const { assertShipInvariants, loadGuardConfig } = await import("./load-config.ts");
  const base = loadGuardConfig();
  assert.throws(
    () => assertShipInvariants({ ...base, allowedCampaignIds: ["120200123", "120200999"] }),
    /allowedCampaignIds/
  );
  // exactly one is acceptable; empty is acceptable only when pause is off (stage 2 arms pause)
  assertShipInvariants({ ...base, allowedCampaignIds: ["120200123"] });
  assertShipInvariants({ ...base, allowedCampaignIds: [], actionModes: { pause: "off" as const, adjust_adset_budget: "off" as const, publish_approved_creative: "off" as const, activate: "off" as const } });
});
