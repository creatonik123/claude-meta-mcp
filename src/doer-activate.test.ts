import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDecision } from "./doer.ts";
import type { Decision } from "./guard.ts";

function fakeWriter() { const calls: Array<{ path: string; body: Record<string, unknown> }> = []; return { calls, async post(path: string, body: Record<string, unknown>) { calls.push({ path, body }); return { success: true }; } }; }
function fakeReader(row: Record<string, unknown>) { return { async get() { return row; } }; }
function fakeCoordinator() { return { async acquire() { return true; }, async release() {}, async alreadyApplied() { return false; }, async markApplied() {} }; }
const deps = (over: Record<string, unknown> = {}) => ({ executionEnabled: true, writer: fakeWriter(), reader: fakeReader({ status: "ACTIVE" }), currencyOffset: 100, coordinator: fakeCoordinator(), ...over });
const allowed: Decision = { allowed: true, effectiveArgs: { entityId: "ad_new_1", status: "ACTIVE" } };

test("activate -> POSTs status=ACTIVE to the ad and verifies status ACTIVE on read-back", async () => {
  const writer = fakeWriter();
  const r = await executeDecision("activate", allowed, deps({ writer }) as never);
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].path, "/ad_new_1");
  assert.deepEqual(writer.calls[0].body, { status: "ACTIVE" });
  assert.equal(r.executed, true);
  if (r.executed) assert.equal(r.verified, true);
});
test("activate read-back still PAUSED -> executed but not verified, reconcile named", async () => {
  const r = await executeDecision("activate", allowed, deps({ reader: fakeReader({ status: "PAUSED" }) }) as never);
  assert.equal(r.executed, true);
  if (r.executed) { assert.equal(r.verified, false); assert.match(String(r.reconcile), /status/); }
});
