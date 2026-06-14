import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeToolRegistration, isForbiddenInRegisteredSet } from "./startup-assert.ts";

// Direct branch coverage for the independent write-detection (so each clause
// carries its weight, not just the default-deny fallthrough).
test("isForbiddenInRegisteredSet: known-write, verb-match, gated, read, unknown", () => {
  assert.equal(isForbiddenInRegisteredSet("create_page_post"), true); // known-write branch
  assert.equal(isForbiddenInRegisteredSet("create_audience"), true); // verb-pattern branch (not in known set)
  assert.equal(isForbiddenInRegisteredSet("pause_entity"), false); // gated write — permitted
  assert.equal(isForbiddenInRegisteredSet("list_campaigns"), false); // allowed read
  assert.equal(isForbiddenInRegisteredSet("frobnicate"), true); // not a read -> default-deny
});

const READS = ["list_campaigns", "get_insights", "list_ad_accounts"];
const GATED = ["pause_entity", "adjust_adset_budget", "publish_approved_creative"];

test("reads only -> boots fine", () => {
  assert.doesNotThrow(() => assertSafeToolRegistration(READS));
});

test("reads + gated writes -> boots fine", () => {
  assert.doesNotThrow(() => assertSafeToolRegistration([...READS, ...GATED]));
});

test("a raw write tool registered -> refuses to boot", () => {
  assert.throws(() => assertSafeToolRegistration([...READS, "create_campaign"]), /refused/);
});

test("the ungated update_adset (vs gated adjust_adset_budget) -> refuses to boot", () => {
  assert.throws(() => assertSafeToolRegistration([...READS, "update_adset"]), /refused/);
});

test("a NEW write-verb tool a future upstream sync might add -> refuses to boot", () => {
  assert.throws(() => assertSafeToolRegistration([...READS, "create_audience"]), /refused/);
  assert.throws(() => assertSafeToolRegistration([...READS, "delete_pixel"]), /refused/);
});

test("a write tool wrongly added to the read path is still caught (independent of the allow-list)", () => {
  // Even if a known write name appeared among 'registered', the backstop
  // detects it by identity, not by the read allow-list.
  assert.throws(() => assertSafeToolRegistration(["create_page_post"]), /refused/);
});
