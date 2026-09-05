/**
 * Ship-stage escalation for the zero-spend smoke test (2026-08-12, operator switch-on):
 * the ship invariant relaxes by EXACTLY ONE notch — `pause` may now be "auto" — and nothing else.
 *
 * The properties that keep this the smallest possible step:
 *  - budget and publish modes remain hard boot-refusals whatever the config says;
 *  - pause accepts only "off" | "auto" (the guard executes only "auto"; "confirm" is a dead half-state) — anything else ("auto", typos) still refuses boot;
 *  - pause "auto" DEMANDS a one-campaign allowlist: an armed pause with an empty allowlist is a
 *    misconfiguration (every call would refuse), and a wide allowlist is exactly what the
 *    ship invariant exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGuardConfig, assertShipInvariants } from "./load-config.ts";

const base = () => loadGuardConfig();

test("pause 'on' with a one-campaign allowlist boots", () => {
  const c = { ...base(), actionModes: { ...base().actionModes, pause: "auto" as const }, allowedCampaignIds: ["52623318982420"] };
  assert.doesNotThrow(() => assertShipInvariants(c));
});

test("pause 'on' with an EMPTY allowlist refuses boot — an armed pause must name its one campaign", () => {
  const c = { ...base(), actionModes: { ...base().actionModes, pause: "auto" as const }, allowedCampaignIds: [] };
  assert.throws(() => assertShipInvariants(c), /allowedCampaignIds|allowlist/i);
});

test("budget 'auto' with a one-campaign allowlist boots (stage 3, the zero-spend budget smoke)", () => {
  const c = { ...base(), actionModes: { ...base().actionModes, adjust_adset_budget: "auto" as const }, allowedCampaignIds: ["52623318982420"] };
  assert.doesNotThrow(() => assertShipInvariants(c));
});

test("budget 'auto' with an EMPTY allowlist refuses boot", () => {
  const c = { ...base(), actionModes: { pause: "off" as const, adjust_adset_budget: "auto" as const, publish_approved_creative: "off" as const, activate: "off" as const }, allowedCampaignIds: [] };
  assert.throws(() => assertShipInvariants(c), /allowedCampaignIds|allowlist/i);
});

test("publish 'auto' with a one-campaign allowlist boots (stage 4, seeded-approval smoke)", () => {
  const c = { ...base(), actionModes: { ...base().actionModes, publish_approved_creative: "auto" as const, activate: "auto" as const }, allowedCampaignIds: ["52623318982420"] };
  assert.doesNotThrow(() => assertShipInvariants(c));
});

test("publish 'auto' with an EMPTY allowlist refuses boot", () => {
  const c = { ...base(), actionModes: { pause: "off" as const, adjust_adset_budget: "off" as const, publish_approved_creative: "auto" as const, activate: "auto" as const }, allowedCampaignIds: [] };
  assert.throws(() => assertShipInvariants(c), /allowedCampaignIds|allowlist/i);
});

test("a pause mode that is neither 'off' nor 'on' still refuses boot", () => {
  const c = { ...base(), actionModes: { ...base().actionModes, pause: "confirm" as const }, allowedCampaignIds: ["52623318982420"] };
  assert.throws(() => assertShipInvariants(c));
});
