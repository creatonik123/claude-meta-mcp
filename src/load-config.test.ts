import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGuardConfig, assertShipInvariants } from "./load-config.ts";

test("the on-disk guard.config.json parses and validates", () => {
  const c = loadGuardConfig();
  assert.equal(c.managedAccountId, "act_1133075730765139");
  assert.equal(c.schemaVersion, 1);
  assert.ok(c.deniedAccountIds.includes("act_2218833115522041"));
});

test("the shipped config satisfies the recommend-only ship invariants", () => {
  const c = loadGuardConfig();
  assert.doesNotThrow(() => assertShipInvariants(c));
  // belt-and-braces: every action mode is exactly 'off'
  for (const m of Object.values(c.actionModes)) assert.equal(m, "off");
});

test("assertShipInvariants throws if any action mode is not 'off'", () => {
  const c = loadGuardConfig();
  const tampered = { ...c, actionModes: { ...c.actionModes, pause: "auto" as const } };
  assert.throws(() => assertShipInvariants(tampered), /recommend-only/);
});

test("assertShipInvariants throws if the forbidden account is removed from the deny list", () => {
  const c = loadGuardConfig();
  const tampered = { ...c, deniedAccountIds: c.deniedAccountIds.filter((a) => a !== "act_2218833115522041") };
  assert.throws(() => assertShipInvariants(tampered), /deniedAccountIds/);
});
