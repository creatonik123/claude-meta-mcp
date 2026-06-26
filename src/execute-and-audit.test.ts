import { test } from "node:test";
import assert from "node:assert/strict";
import { executeAndAudit } from "./execute-and-audit.ts";
import type { DoerDeps } from "./doer.ts";
import type { Decision } from "./guard.ts";
import type { AuditEntry, AuditSink } from "./audit.ts";

function recordingAudit(): AuditSink & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return { entries, async write(e) { entries.push(e); } };
}

function throwingAudit(msg = "audit DB down"): AuditSink {
  return { async write() { throw new Error(msg); } };
}

function doerDeps(over: Partial<DoerDeps> = {}): DoerDeps & { _calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    executionEnabled: true,
    writer: { async post(path, body) { calls.push({ path, body }); return { ok: true }; } },
    reader: { async get() { return { status: "PAUSED" }; } },
    coordinator: {
      async acquire() { return true; },
      async release() {},
      async alreadyApplied() { return false; },
      async markApplied() {},
    },
    currencyOffset: 100,
    ...over,
    _calls: calls,
  } as DoerDeps & { _calls: typeof calls };
}

const allowedPause: Decision = { allowed: true, effectiveArgs: { entityId: "23890", status: "PAUSED" } };
const now = () => new Date("2026-06-26T00:00:00.000Z");

test("allowed + execution enabled -> executes, audited true, ONE execution audit entry (executed_verified)", async () => {
  const audit = recordingAudit();
  const deps = doerDeps({ executionEnabled: true });
  const outcome = await executeAndAudit("pause", allowedPause, deps, audit, now);
  assert.ok(outcome && outcome.execution.executed === true);
  assert.equal(outcome.audited, true);
  assert.equal(deps._calls.length, 1);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].result, "executed_verified");
  assert.equal(audit.entries[0].entityId, "23890");
});

test("execution DISABLED -> returns null, NO write, NO execution audit", async () => {
  const audit = recordingAudit();
  const deps = doerDeps({ executionEnabled: false });
  const outcome = await executeAndAudit("pause", allowedPause, deps, audit, now);
  assert.equal(outcome, null);
  assert.equal(deps._calls.length, 0);
  assert.equal(audit.entries.length, 0);
});

test("refused decision -> returns null, NO write, NO execution audit", async () => {
  const audit = recordingAudit();
  const deps = doerDeps({ executionEnabled: true });
  const refused: Decision = { allowed: false, code: "account_cap", reason: "over cap" };
  const outcome = await executeAndAudit("adjust_adset_budget", refused, deps, audit, now);
  assert.equal(outcome, null);
  assert.equal(deps._calls.length, 0);
  assert.equal(audit.entries.length, 0);
});

test("a needs-reconcile execution is still audited (executed_needs_reconcile)", async () => {
  const audit = recordingAudit();
  const deps = doerDeps({ executionEnabled: true, reader: { async get() { return { status: "ACTIVE" }; } } });
  const outcome = await executeAndAudit("pause", allowedPause, deps, audit, now);
  assert.ok(outcome && outcome.execution.executed === true && outcome.execution.verified === false);
  assert.equal(outcome.audited, true);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].result, "executed_needs_reconcile");
});

test("audit.write THROWS after a real write -> does NOT throw, returns audited:false (R7: executed-but-unlogged surfaced for reconcile, never lost, never crashes the caller)", async () => {
  const deps = doerDeps({ executionEnabled: true });
  // If executeAndAudit rethrew the audit error, this await would throw and fail the test.
  const outcome = await executeAndAudit("pause", allowedPause, deps, throwingAudit("audit DB down"), now);
  assert.equal(deps._calls.length, 1); // the Meta write happened
  assert.ok(outcome && outcome.execution.executed === true);
  assert.equal(outcome.audited, false);
  assert.match(String(outcome.auditError), /audit DB down/);
});
