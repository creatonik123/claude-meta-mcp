import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionEnabled, EXECUTION_ENV_FLAG, assertExecutionBootSafe } from "./execution-config.ts";

const ON = { [EXECUTION_ENV_FLAG]: "true" };
const fullDeps = (): Record<string, unknown> => ({
  writer: { async post() { return {}; } },
  reader: { async get() { return {}; } },
  coordinator: { async acquire() { return true; }, async release() {}, async alreadyApplied() { return false; }, async markApplied() {} },
  currencyOffset: 100,
});

test("missing flag -> execution OFF (the safe default)", () => {
  assert.equal(resolveExecutionEnabled({}), false);
});

test("only an explicit 'true' or '1' enables execution", () => {
  assert.equal(resolveExecutionEnabled({ [EXECUTION_ENV_FLAG]: "true" }), true);
  assert.equal(resolveExecutionEnabled({ [EXECUTION_ENV_FLAG]: "1" }), true);
});

test("any other value fails safe to OFF (typos / partial config never enable spend)", () => {
  for (const v of ["false", "0", "", "yes", "TRUE", "on", "enabled", " 1", "1 "]) {
    assert.equal(resolveExecutionEnabled({ [EXECUTION_ENV_FLAG]: v }), false, `value '${v}' must not enable`);
  }
});

test("undefined env value -> OFF", () => {
  assert.equal(resolveExecutionEnabled({ [EXECUTION_ENV_FLAG]: undefined }), false);
});

// --- assertExecutionBootSafe: never boot with execution ON but incomplete wiring ---
test("boot: execution OFF -> safe regardless of wiring (recommend-only)", () => {
  assert.doesNotThrow(() => assertExecutionBootSafe({}, {}));
});
test("boot: execution ON + complete valid wiring -> safe", () => {
  assert.doesNotThrow(() => assertExecutionBootSafe(ON, fullDeps()));
});
test("boot: execution ON but a port is missing -> THROWS (refuse to boot half-wired)", () => {
  for (const drop of ["writer", "reader", "coordinator"]) {
    const d = fullDeps();
    delete d[drop];
    assert.throws(() => assertExecutionBootSafe(ON, d), new RegExp(drop, "i"), `should refuse when ${drop} missing`);
  }
});
test("boot: execution ON + invalid currencyOffset -> THROWS", () => {
  for (const bad of [0, -1, 1.5, NaN, undefined, "100"]) {
    const d = fullDeps();
    d.currencyOffset = bad;
    assert.throws(() => assertExecutionBootSafe(ON, d), /offset/i, `should refuse offset=${String(bad)}`);
  }
});
