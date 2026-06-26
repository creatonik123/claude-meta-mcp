import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDecision, type MetaWriter, type MetaReader, type ExecutionCoordinator } from "./doer.ts";
import type { Decision } from "./guard.ts";

// Records every write so a test can assert exactly what hit (or didn't hit) Meta.
function fakeWriter(): MetaWriter & { calls: Array<{ path: string; body: Record<string, unknown> }> } {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      return { id: path.replace(/^\//, ""), success: true };
    },
  };
}

// A writer whose POST rejects (timeout / 5xx / rate-limit) — the write may or may
// not have reached and applied at Meta.
function throwingWriter(): MetaWriter & { calls: number } {
  return {
    calls: 0,
    async post() {
      this.calls++;
      throw new Error("write network error / timeout");
    },
  };
}

// Read-back fake: returns a canned entity object, or throws if `fail` is set.
function fakeReader(entity: Record<string, unknown>, fail = false): MetaReader {
  return {
    async get() {
      if (fail) throw new Error("read-back network error");
      return entity;
    },
  };
}

// Single-flight lock + idempotency coordinator. Permissive by default (acquires,
// nothing applied yet); records every call so tests can assert lock/dedupe behaviour.
function fakeCoordinator(opts: {
  applied?: boolean;
  acquire?: boolean;
  throwOn?: "acquire" | "alreadyApplied";
} = {}): ExecutionCoordinator & { log: { acquired: string[]; released: string[]; marked: string[] } } {
  const log = { acquired: [] as string[], released: [] as string[], marked: [] as string[] };
  return {
    log,
    async acquire(key) {
      if (opts.throwOn === "acquire") throw new Error("lock store error");
      log.acquired.push(key);
      return opts.acquire ?? true;
    },
    async release(key) {
      log.released.push(key);
    },
    async alreadyApplied(key) {
      if (opts.throwOn === "alreadyApplied") throw new Error("idempotency store error");
      return opts.applied ?? false;
    },
    async markApplied(key) {
      log.marked.push(key);
    },
  };
}

// Default deps for a happy enabled pause that verifies clean.
function deps(over: Partial<Parameters<typeof executeDecision>[2]> = {}) {
  return {
    executionEnabled: true,
    writer: fakeWriter(),
    reader: fakeReader({ status: "PAUSED" }),
    currencyOffset: 100,
    coordinator: fakeCoordinator(),
    ...over,
  };
}

const allowedPause: Decision = { allowed: true, effectiveArgs: { entityId: "23890", status: "PAUSED" } };
const allowedBudget: Decision = { allowed: true, effectiveArgs: { entityId: "23890", dailyBudget: 50 } };

// ---- Slice 1: execution gate + translation ------------------------------------

test("execution disabled -> performs NO write (the default, fail-safe)", async () => {
  const writer = fakeWriter();
  const result = await executeDecision("pause", allowedPause, deps({ executionEnabled: false, writer }));
  assert.equal(writer.calls.length, 0);
  assert.equal(result.executed, false);
  if (result.executed === false) assert.match(result.reason, /execution.*off|disabled/i);
});

test("enabled pause -> POSTs status=PAUSED and verifies it took (verified true)", async () => {
  const writer = fakeWriter();
  const result = await executeDecision("pause", allowedPause, deps({ writer, reader: fakeReader({ status: "PAUSED" }) }));
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].path, "/23890");
  assert.deepEqual(writer.calls[0].body, { status: "PAUSED" });
  assert.equal(result.executed, true);
  if (result.executed === true) assert.equal(result.verified, true);
});

test("enabled budget -> converts whole AUD to cents (A$50 -> 5000) and verifies", async () => {
  const writer = fakeWriter();
  const result = await executeDecision("adjust_adset_budget", allowedBudget, deps({ writer, reader: fakeReader({ daily_budget: "5000" }) }));
  assert.equal(writer.calls.length, 1);
  assert.deepEqual(writer.calls[0].body, { daily_budget: 5000 });
  assert.equal(result.executed, true);
  if (result.executed === true) assert.equal(result.verified, true);
});

test("budget honours a zero-decimal currency offset (offset 1 -> daily_budget 50, NOT 5000)", async () => {
  const writer = fakeWriter();
  await executeDecision("adjust_adset_budget", allowedBudget, deps({ writer, reader: fakeReader({ daily_budget: "50" }), currencyOffset: 1 }));
  assert.equal(writer.calls.length, 1);
  assert.deepEqual(writer.calls[0].body, { daily_budget: 50 });
});

test("budget with an invalid currency offset -> NO write (fail-closed, never guess the units)", async () => {
  const writer = fakeWriter();
  const result = await executeDecision("adjust_adset_budget", allowedBudget, deps({ writer, currencyOffset: 0 }));
  assert.equal(writer.calls.length, 0);
  assert.equal(result.executed, false);
});

test("budget with a malformed dailyBudget -> NO write (fail-closed, never post NaN/garbage)", async () => {
  const bad: unknown[] = [undefined, "50", Infinity, NaN, -5, 0, {}, null];
  for (const v of bad) {
    const writer = fakeWriter();
    const decision: Decision = { allowed: true, effectiveArgs: { entityId: "23890", dailyBudget: v } };
    const result = await executeDecision("adjust_adset_budget", decision, deps({ writer }));
    assert.equal(writer.calls.length, 0, `must not write for dailyBudget=${String(v)}`);
    assert.equal(result.executed, false, `must refuse for dailyBudget=${String(v)}`);
  }
});

test("an allowed publish_approved_creative -> structured NO write (handled by the creative pipeline, not a crash)", async () => {
  const writer = fakeWriter();
  const decision: Decision = { allowed: true, effectiveArgs: { approvalHash: "abc" } };
  const result = await executeDecision("publish_approved_creative", decision, deps({ writer }));
  assert.equal(writer.calls.length, 0);
  assert.equal(result.executed, false);
  if (result.executed === false) assert.match(result.reason, /creative pipeline/i);
});

test("enabled but decision was REFUSED -> performs NO write", async () => {
  const writer = fakeWriter();
  const refused: Decision = { allowed: false, code: "account_cap", reason: "over cap" };
  const result = await executeDecision("adjust_adset_budget", refused, deps({ writer }));
  assert.equal(writer.calls.length, 0);
  assert.equal(result.executed, false);
});

// ---- Slice 2: read-back verification ------------------------------------------

test("pause read-back shows it did NOT take (still ACTIVE) -> executed but verified false, reconcile flagged", async () => {
  const writer = fakeWriter();
  const result = await executeDecision("pause", allowedPause, deps({ writer, reader: fakeReader({ status: "ACTIVE" }) }));
  assert.equal(writer.calls.length, 1);
  assert.equal(result.executed, true);
  if (result.executed === true) {
    assert.equal(result.verified, false);
    assert.ok(result.reconcile && /status|active|paused/i.test(result.reconcile));
  }
});

test("read-back uses `status`, not `effective_status` (WITH_ISSUES is not a pause failure)", async () => {
  const result = await executeDecision("pause", allowedPause, deps({ reader: fakeReader({ status: "PAUSED", effective_status: "WITH_ISSUES" }) }));
  assert.equal(result.executed, true);
  if (result.executed === true) assert.equal(result.verified, true);
});

test("budget read-back shows a different value -> verified false, reconcile flagged", async () => {
  const result = await executeDecision("adjust_adset_budget", allowedBudget, deps({ reader: fakeReader({ daily_budget: "9999" }) }));
  assert.equal(result.executed, true);
  if (result.executed === true) {
    assert.equal(result.verified, false);
    assert.ok(result.reconcile);
  }
});

test("read-back itself fails -> the write HAPPENED, so executed true but verified false (needs reconcile, not silent success)", async () => {
  const writer = fakeWriter();
  const result = await executeDecision("pause", allowedPause, deps({ writer, reader: fakeReader({}, true) }));
  assert.equal(writer.calls.length, 1);
  assert.equal(result.executed, true);
  if (result.executed === true) {
    assert.equal(result.verified, false);
    assert.ok(result.reconcile && /read|verif|confirm/i.test(result.reconcile));
  }
});

test("write call throws but read-back shows the change DID apply -> verified true (no lost write)", async () => {
  const result = await executeDecision("pause", allowedPause, deps({ writer: throwingWriter(), reader: fakeReader({ status: "PAUSED" }) }));
  assert.equal(result.executed, true);
  if (result.executed === true) assert.equal(result.verified, true);
});

test("write call throws and read-back shows the change is NOT present -> executed false, and the reason states only what was observed (not a false 'unchanged' claim)", async () => {
  const result = await executeDecision("pause", allowedPause, deps({ writer: throwingWriter(), reader: fakeReader({ status: "ACTIVE" }) }));
  assert.equal(result.executed, false);
  if (result.executed === false) {
    // It never read the pre-write value, so it must not claim the entity is "unchanged".
    assert.doesNotMatch(result.reason, /unchanged/i);
    // It should report the value it actually observed.
    assert.match(result.reason, /ACTIVE|not present|did not apply/i);
  }
});

test("write call throws AND read-back also fails -> executed true, verified false, reconcile (fully ambiguous, never silently dropped)", async () => {
  const result = await executeDecision("pause", allowedPause, deps({ writer: throwingWriter(), reader: fakeReader({}, true) }));
  assert.equal(result.executed, true);
  if (result.executed === true) {
    assert.equal(result.verified, false);
    assert.ok(result.reconcile);
  }
});

// ---- Slice 3: single-flight lock + idempotency --------------------------------

test("an action already applied this cycle -> idempotent skip, NO second write", async () => {
  const writer = fakeWriter();
  const result = await executeDecision("pause", allowedPause, deps({ writer, coordinator: fakeCoordinator({ applied: true }) }));
  assert.equal(writer.calls.length, 0);
  assert.equal(result.executed, false);
  if (result.executed === false) assert.match(result.reason, /idempotent|already applied/i);
});

test("lock not acquired (another write in progress) -> NO write, skipped", async () => {
  const writer = fakeWriter();
  const result = await executeDecision("pause", allowedPause, deps({ writer, coordinator: fakeCoordinator({ acquire: false }) }));
  assert.equal(writer.calls.length, 0);
  assert.equal(result.executed, false);
  if (result.executed === false) assert.match(result.reason, /lock|in progress/i);
});

test("a successful verified write -> marks the action applied AND releases the lock", async () => {
  const coordinator = fakeCoordinator();
  await executeDecision("pause", allowedPause, deps({ coordinator }));
  assert.deepEqual(coordinator.log.acquired, ["23890"]);
  assert.deepEqual(coordinator.log.marked, ["pause:/23890:{\"status\":\"PAUSED\"}"]);
  assert.deepEqual(coordinator.log.released, ["23890"]);
});

test("the lock is released even when the outcome needs reconcile (verified false)", async () => {
  const coordinator = fakeCoordinator();
  await executeDecision("pause", allowedPause, deps({ reader: fakeReader({ status: "ACTIVE" }), coordinator }));
  assert.deepEqual(coordinator.log.released, ["23890"]); // released despite the mismatch
  assert.equal(coordinator.log.marked.length, 0); // an unverified write is NOT marked applied
});

test("acquiring the lock throws -> fail-closed, NO write", async () => {
  const writer = fakeWriter();
  const result = await executeDecision("pause", allowedPause, deps({ writer, coordinator: fakeCoordinator({ throwOn: "acquire" }) }));
  assert.equal(writer.calls.length, 0);
  assert.equal(result.executed, false);
});

test("the idempotency check throws -> fail-closed, NO write", async () => {
  const writer = fakeWriter();
  const result = await executeDecision("pause", allowedPause, deps({ writer, coordinator: fakeCoordinator({ throwOn: "alreadyApplied" }) }));
  assert.equal(writer.calls.length, 0);
  assert.equal(result.executed, false);
});
