import { test } from "node:test";
import assert from "node:assert/strict";
import { executionAuditEntry } from "./execute-audit.ts";
import type { ExecutionResult } from "./doer.ts";
import type { Decision } from "./guard.ts";

const allowedPause: Decision = { allowed: true, effectiveArgs: { entityId: "23890", status: "PAUSED" } };
const TS = "2026-06-26T00:00:00.000Z";

test("a verified execution -> audit result 'executed_verified' with the entity and what was written", () => {
  const result: ExecutionResult = { executed: true, verified: true, wrote: { path: "/23890", body: { status: "PAUSED" } }, result: { ok: true } };
  const entry = executionAuditEntry("pause", allowedPause, result, TS);
  assert.equal(entry.result, "executed_verified");
  assert.equal(entry.entityId, "23890");
  assert.equal(entry.action, "pause");
  assert.equal(entry.ts, TS);
  assert.deepEqual(entry.details.wrote, { path: "/23890", body: { status: "PAUSED" } });
});

test("an unverified execution -> audit result 'executed_needs_reconcile' carrying the reconcile reason", () => {
  const result: ExecutionResult = { executed: true, verified: false, wrote: { path: "/23890", body: { status: "PAUSED" } }, result: null, reconcile: "read-back status='ACTIVE' did not match expected 'PAUSED'" };
  const entry = executionAuditEntry("pause", allowedPause, result, TS);
  assert.equal(entry.result, "executed_needs_reconcile");
  assert.equal(entry.ruleTriggered, "needs_reconcile");
  assert.match(String(entry.details.reconcile), /ACTIVE/);
});

test("a no-write outcome -> audit result 'not_executed' with the reason", () => {
  const result: ExecutionResult = { executed: false, reason: "execution disabled (recommend-only) — no write performed" };
  const entry = executionAuditEntry("pause", allowedPause, result, TS);
  assert.equal(entry.result, "not_executed");
  assert.match(String(entry.details.reason), /disabled/);
});

test("a refused decision -> entityId is still null-safe (no effectiveArgs to read)", () => {
  const refused: Decision = { allowed: false, code: "account_cap", reason: "over cap" };
  const result: ExecutionResult = { executed: false, reason: "decision was refused by the guard — not executed" };
  const entry = executionAuditEntry("adjust_adset_budget", refused, result, TS);
  assert.equal(entry.result, "not_executed");
  assert.equal(entry.entityId, null);
});
