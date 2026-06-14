import { test } from "node:test";
import assert from "node:assert/strict";
import { installReadOnlyGate, type ToolRegistrar } from "./read-only-gate.ts";
import { assertSafeToolRegistration } from "./startup-assert.ts";

function fakeMcp() {
  const realCalls: string[] = [];
  const mcp: ToolRegistrar = {
    registerTool: (name: string) => {
      realCalls.push(name);
      return { name };
    },
  };
  return { mcp, realCalls };
}

test("gate: only read tools register; writes are attempted but dropped (never reach the real registrar)", () => {
  const { mcp, realCalls } = fakeMcp();
  const { attempted, registered } = installReadOnlyGate(mcp);
  mcp.registerTool("list_campaigns");
  mcp.registerTool("create_campaign"); // write -> dropped
  mcp.registerTool("get_insights");
  assert.deepEqual(attempted, ["list_campaigns", "create_campaign", "get_insights"]);
  assert.deepEqual(registered, ["list_campaigns", "get_insights"]);
  assert.deepEqual(realCalls, ["list_campaigns", "get_insights"]);
});

test("gate output passes the startup backstop (reads only)", () => {
  const { mcp } = fakeMcp();
  const { registered } = installReadOnlyGate(mcp);
  mcp.registerTool("list_campaigns");
  mcp.registerTool("delete_campaign"); // dropped
  assert.doesNotThrow(() => assertSafeToolRegistration(registered));
});

test("backstop FIRES if a write somehow lands in the registered set (gate-failure simulation)", () => {
  assert.throws(() => assertSafeToolRegistration(["list_campaigns", "create_campaign"]), /refused/);
});

test("onRefused callback fires once per dropped write tool", () => {
  const { mcp } = fakeMcp();
  const refused: string[] = [];
  installReadOnlyGate(mcp, (name) => refused.push(name));
  mcp.registerTool("list_campaigns"); // allowed
  mcp.registerTool("create_campaign"); // dropped -> callback
  mcp.registerTool("delete_ad"); // dropped -> callback
  assert.deepEqual(refused, ["create_campaign", "delete_ad"]);
});
