import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGuardConfig, parseGuardConfig, assertShipInvariants, FORBIDDEN_ACCOUNT } from "./load-config.ts";

test("the on-disk guard.config.json parses and validates", () => {
  const c = loadGuardConfig();
  assert.equal(c.managedAccountId, "act_2218833115522041");
  assert.equal(c.schemaVersion, 1);
  assert.ok(c.deniedAccountIds.includes("act_1133075730765139"));
});

test("the shipped config satisfies the recommend-only ship invariants", () => {
  const c = loadGuardConfig();
  assert.doesNotThrow(() => assertShipInvariants(c));
  // belt-and-braces: every action mode is exactly 'off'
  for (const m of Object.values(c.actionModes)) assert.equal(m, "off");
});

test("a non-IANA accountTimezone is refused at config load (boot), not at decision time", () => {
  const c = loadGuardConfig();
  assert.throws(() => parseGuardConfig({ ...c, accountTimezone: "Mars/Phobos" }), /IANA/);
  assert.throws(() => parseGuardConfig({ ...c, accountTimezone: "" }));
});

test("assertShipInvariants throws if any action mode is not 'off'", () => {
  const c = loadGuardConfig();
  const tampered = { ...c, actionModes: { ...c.actionModes, pause: "auto" as const } };
  assert.throws(() => assertShipInvariants(tampered), /recommend-only/);
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
  // zero (shipped) and exactly one are both acceptable
  assertShipInvariants({ ...base, allowedCampaignIds: [] });
  assertShipInvariants({ ...base, allowedCampaignIds: ["120200123"] });
});
