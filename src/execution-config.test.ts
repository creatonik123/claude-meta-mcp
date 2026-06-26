import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionEnabled, EXECUTION_ENV_FLAG } from "./execution-config.ts";

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
