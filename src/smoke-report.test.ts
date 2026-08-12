/**
 * The zero-spend smoke test's decision logic. The runner script (scripts/ note in smoke-report.ts)
 * is a thin IO shell around these two functions, so everything that could misjudge the system's
 * state is testable without a network. The stakes: this is the FIRST time the write path ever
 * executes, and the report must never call a half-working state a pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessSurface, judgeSmokeRun, WRITE_TOOLS } from "./smoke-report.js";

// ---- phase A: is the deployment in the state we think it is? ----------------

test("all-read surface -> inert:true, and the report says switch-on is the next step", () => {
  const a = assessSurface(["get_campaigns", "get_ads"]);
  assert.equal(a.inert, true);
  assert.deepEqual(a.writeToolsPresent, []);
  assert.match(a.summary, /ADPILOT_EXECUTION_ENABLED/);
});

test("all three write tools present -> armed:true", () => {
  const a = assessSurface(["get_campaigns", ...WRITE_TOOLS]);
  assert.equal(a.inert, false);
  assert.equal(a.armed, true);
});

test("a PARTIAL write surface is an error state, never 'armed' — half a deployment must not smoke-test", () => {
  const a = assessSurface(["get_campaigns", "pause_entity"]);
  assert.equal(a.inert, false);
  assert.equal(a.armed, false);
  assert.match(a.summary, /partial/i);
});

// ---- phase B: did the one pause do exactly what a pass requires? -------------

const okPause = { status: "executed_verified" };

test("verified pause + exactly 2 new audit rows = PASS", () => {
  const v = judgeSmokeRun({ pauseResult: okPause, auditBefore: 0, auditAfter: 2 });
  assert.equal(v.pass, true);
});

test("a REFUSED pause is not a pass — the guard said no and the report must say which gate", () => {
  const v = judgeSmokeRun({
    pauseResult: { status: "refused", reason: "campaign_not_allowlisted" },
    auditBefore: 0,
    auditAfter: 1,
  });
  assert.equal(v.pass, false);
  assert.match(v.summary, /campaign_not_allowlisted/);
});

test("a verified pause with NO new audit rows is a FAIL — an unaudited write is worse than no write", () => {
  const v = judgeSmokeRun({ pauseResult: okPause, auditBefore: 5, auditAfter: 5 });
  assert.equal(v.pass, false);
  assert.match(v.summary, /audit/i);
});

test("an unreadable audit count fails closed, never passes", () => {
  const v = judgeSmokeRun({ pauseResult: okPause, auditBefore: 3, auditAfter: null });
  assert.equal(v.pass, false);
});

test("needs_reconcile is reported as NOT a pass — the write may have landed but was not proven", () => {
  const v = judgeSmokeRun({
    pauseResult: { status: "executed_needs_reconcile" },
    auditBefore: 0,
    auditAfter: 2,
  });
  assert.equal(v.pass, false);
  assert.match(v.summary, /reconcile/i);
});
