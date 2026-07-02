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

// ---- gated writes register ONLY when explicitly allowed (execution wiring) ----

test("by default the gate refuses even the GATED write tools", () => {
  const { mcp, realCalls } = fakeMcp();
  const { registered } = installReadOnlyGate(mcp);
  mcp.registerTool("pause_entity");
  mcp.registerTool("adjust_adset_budget");
  assert.deepEqual(registered, []);
  assert.deepEqual(realCalls, []);
});

test("allowGatedWrites lets exactly the 3 gated tools through — raw writes still refused", () => {
  const { mcp, realCalls } = fakeMcp();
  const { registered } = installReadOnlyGate(mcp, undefined, { allowGatedWrites: true });
  mcp.registerTool("pause_entity");
  mcp.registerTool("adjust_adset_budget");
  mcp.registerTool("publish_approved_creative");
  mcp.registerTool("update_adset"); // raw upstream write -> still dropped
  mcp.registerTool("delete_campaign"); // still dropped
  mcp.registerTool("list_campaigns"); // reads unaffected
  assert.deepEqual(registered, ["pause_entity", "adjust_adset_budget", "publish_approved_creative", "list_campaigns"]);
  assert.deepEqual(realCalls, registered);
  // and the boot backstop accepts this exact set
  assert.doesNotThrow(() => assertSafeToolRegistration(registered));
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
