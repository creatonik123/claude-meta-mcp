import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_TO_ACTION,
  currencyOffsetFor,
  buildExecutionDeps,
  registerGatedWriteTools,
  wireExecution,
  withDayScopedDedupe,
} from "./execution-wiring.ts";
import { GATED_WRITE_TOOLS } from "./tool-gate.ts";
import { loadGuardConfig } from "./load-config.ts";
import type { GuardConfig, GuardDeps } from "./guard.ts";
import type { DoerDeps } from "./doer.ts";
import type { AuditEntry } from "./audit.ts";

// ---- fakes -----------------------------------------------------------------

function fakeMcp() {
  const tools: Record<string, { meta: unknown; cb: (args: Record<string, unknown>) => Promise<unknown> }> = {};
  return {
    tools,
    registerTool(name: string, meta: unknown, cb: (args: Record<string, unknown>) => Promise<unknown>) {
      tools[name] = { meta, cb };
      return undefined;
    },
  };
}

import type { GraphClient } from "./meta-adapters.ts";

const fakeClient: GraphClient = {
  get: async <T = unknown>() => ({} as T),
  post: async <T = unknown>() => ({} as T),
};

function offConfig(): GuardConfig {
  return loadGuardConfig(); // the shipped config: all action modes 'off'
}

function autoConfig(): GuardConfig {
  const c = offConfig();
  return { ...c, actionModes: { pause: "auto", adjust_adset_budget: "auto", publish_approved_creative: "auto" } };
}

function fakeGuardDeps(config: GuardConfig, audits: AuditEntry[]): { guardDeps: GuardDeps; audit: { write: (e: AuditEntry) => Promise<void> } } {
  return {
    guardDeps: {
      config,
      now: () => new Date("2026-06-14T10:00:00Z"),
      env: {},
      db: {
        schemaVersion: async () => 1,
        killSwitchRow: async () => false,
        approvalByHash: async () => ({ consumed: false }),
        startOfDayBudget: async () => 100,
        accountStartOfDayTotal: async () => 1000,
        budgetBaseline30d: async () => 1000,
      },
      meta: {
        entityAccountId: async () => "act_1133075730765139",
        currentBudget: async () => ({ dailyBudget: 100, lifetimeBudget: null, ownedByCampaignCbo: false }),
        realisedSpend: async () => ({ today: 50, monthToDate: 2000, dateStop: "2026-06-14", complete: true }),
        accountActiveDailyBudgetTotal: async () => 1000,
      },
    },
    audit: { write: async (e: AuditEntry) => { audits.push(e); } },
  };
}

function fakeDoerDeps(writes: Array<{ path: string; body: Record<string, unknown> }>): DoerDeps {
  let budgetAfterWrite = "100";
  return {
    executionEnabled: true,
    writer: {
      post: async (path, body) => {
        writes.push({ path, body: body as Record<string, unknown> });
        if (body.daily_budget != null) budgetAfterWrite = String(body.daily_budget);
        return { success: true };
      },
    },
    reader: {
      get: async (_id, fields) =>
        fields[0] === "status" ? { status: "PAUSED" } : { daily_budget: budgetAfterWrite },
    },
    coordinator: {
      acquire: async () => true,
      release: async () => {},
      alreadyApplied: async () => false,
      markApplied: async () => {},
    },
    currencyOffset: 100,
  };
}

// ---- tool-name -> action map stays in sync with the gate ----

test("TOOL_TO_ACTION keys are exactly GATED_WRITE_TOOLS (no drift)", () => {
  assert.deepEqual(new Set(Object.keys(TOOL_TO_ACTION)), GATED_WRITE_TOOLS);
});

test("TOOL_TO_ACTION maps pause_entity to the guard's 'pause' action", () => {
  assert.equal(TOOL_TO_ACTION.pause_entity, "pause");
  assert.equal(TOOL_TO_ACTION.adjust_adset_budget, "adjust_adset_budget");
  assert.equal(TOOL_TO_ACTION.publish_approved_creative, "publish_approved_creative");
});

// ---- currency offset: known currency only, never guessed ----

test("currencyOffsetFor knows AUD; refuses anything unknown", () => {
  assert.equal(currencyOffsetFor("AUD"), 100);
  assert.throws(() => currencyOffsetFor("JPY"), /unknown currency/i);
  assert.throws(() => currencyOffsetFor(undefined), /unknown currency/i);
});

// ---- wireExecution: the default-OFF master gate ----

test("flag unset -> wireExecution constructs NOTHING and registers NOTHING", () => {
  const mcp = fakeMcp();
  const out = wireExecution(mcp, { env: {}, client: fakeClient, guardConfig: offConfig() });
  assert.equal(out.enabled, false);
  assert.deepEqual(out.tools, []);
  assert.deepEqual(Object.keys(mcp.tools), []);
});

test("flag explicitly false/garbage -> still OFF", () => {
  for (const v of ["false", "0", "yes", "on", "TRUE ", ""]) {
    const mcp = fakeMcp();
    const out = wireExecution(mcp, {
      env: { ADPILOT_EXECUTION_ENABLED: v },
      client: fakeClient,
      guardConfig: offConfig(),
    });
    assert.equal(out.enabled, false, `value '${v}' must not enable execution`);
    assert.deepEqual(Object.keys(mcp.tools), []);
  }
});

test("flag on -> registers exactly the 3 gated write tools (dummy DB url, no connect)", () => {
  const mcp = fakeMcp();
  const out = wireExecution(mcp, {
    env: { ADPILOT_EXECUTION_ENABLED: "1", DATABASE_URL: "postgres://u:p@h/db" },
    client: fakeClient,
    guardConfig: offConfig(),
  });
  assert.equal(out.enabled, true);
  assert.deepEqual(new Set(out.tools), GATED_WRITE_TOOLS);
  assert.deepEqual(new Set(Object.keys(mcp.tools)), GATED_WRITE_TOOLS);
});

test("flag on WITHOUT a database url -> refuses to boot (fail-closed), registers nothing", () => {
  const mcp = fakeMcp();
  assert.throws(() =>
    wireExecution(mcp, { env: { ADPILOT_EXECUTION_ENABLED: "1" }, client: fakeClient, guardConfig: offConfig() })
  );
  assert.deepEqual(Object.keys(mcp.tools), []);
});

test("flag on with an unknown currency -> refuses to boot, registers nothing", () => {
  const mcp = fakeMcp();
  const cfg = { ...offConfig(), currency: "XYZ" };
  assert.throws(() =>
    wireExecution(mcp, {
      env: { ADPILOT_EXECUTION_ENABLED: "1", DATABASE_URL: "postgres://u:p@h/db" },
      client: fakeClient,
      guardConfig: cfg,
    })
  );
  assert.deepEqual(Object.keys(mcp.tools), []);
});

// ---- buildExecutionDeps: per-boot-unique holder ----

test("each boot gets its own coordinator holder (run-scoped dedupe)", () => {
  const env = { DATABASE_URL: "postgres://u:p@h/db" };
  const a = buildExecutionDeps(env, fakeClient, offConfig());
  const b = buildExecutionDeps(env, fakeClient, offConfig());
  assert.match(a.holder, /^mcp-/);
  assert.notEqual(a.holder, b.holder);
});

// ---- day-scoped dedupe: a long-lived server must not dedupe across days ----

test("withDayScopedDedupe prefixes dedupe keys with the day; locks pass through untouched", async () => {
  const seen: string[] = [];
  const inner = {
    acquire: async (k: string) => { seen.push(`acquire:${k}`); return true; },
    release: async (k: string) => { seen.push(`release:${k}`); },
    alreadyApplied: async (k: string) => { seen.push(`already:${k}`); return false; },
    markApplied: async (k: string) => { seen.push(`mark:${k}`); },
  };
  let today = "2026-06-14";
  const wrapped = withDayScopedDedupe(inner, () => today);
  await wrapped.acquire("as_1");
  await wrapped.alreadyApplied("pause:/as_1:{}");
  await wrapped.markApplied("pause:/as_1:{}");
  today = "2026-06-15"; // next day: same action key gets a DIFFERENT dedupe key
  await wrapped.alreadyApplied("pause:/as_1:{}");
  await wrapped.release("as_1");
  assert.deepEqual(seen, [
    "acquire:as_1",
    "already:2026-06-14:pause:/as_1:{}",
    "mark:2026-06-14:pause:/as_1:{}",
    "already:2026-06-15:pause:/as_1:{}",
    "release:as_1",
  ]);
});

test("withDayScopedDedupe fails closed when the day cannot be resolved", async () => {
  const inner = {
    acquire: async () => true,
    release: async () => {},
    alreadyApplied: async () => false,
    markApplied: async () => {},
  };
  const wrapped = withDayScopedDedupe(inner, () => { throw new Error("tz broke"); });
  await assert.rejects(() => wrapped.alreadyApplied("k"), /tz broke/); // doer turns this into a no-write refusal
});

// ---- the handler chain, with the SHIPPED (all-off) config: refuse + audit ----

test("with shipped config, a pause call is REFUSED (action_mode_off) and audited — no write", async () => {
  const mcp = fakeMcp();
  const audits: AuditEntry[] = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const { guardDeps, audit } = fakeGuardDeps(offConfig(), audits);
  registerGatedWriteTools(mcp, { guardDeps, doerDeps: fakeDoerDeps(writes), audit });

  const res = (await mcp.tools.pause_entity.cb({ entityId: "as_1" })) as { content: Array<{ text: string }> };
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.decision.allowed, false);
  assert.equal(payload.decision.code, "action_mode_off");
  assert.equal(payload.execution, null);
  assert.equal(writes.length, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].result, "refused");
});

// ---- the handler chain with modes 'auto' + fakes: executes and verifies ----

test("with modes auto, pause executes through the doer and read-back verifies", async () => {
  const mcp = fakeMcp();
  const audits: AuditEntry[] = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const { guardDeps, audit } = fakeGuardDeps(autoConfig(), audits);
  registerGatedWriteTools(mcp, { guardDeps, doerDeps: fakeDoerDeps(writes), audit });

  const res = (await mcp.tools.pause_entity.cb({ entityId: "as_1" })) as { content: Array<{ text: string }> };
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.decision.allowed, true);
  assert.equal(payload.execution.executed, true);
  assert.equal(payload.execution.verified, true);
  assert.deepEqual(writes, [{ path: "/as_1", body: { status: "PAUSED" } }]);
  assert.equal(audits.length, 2); // decision + execution outcome
  assert.equal(audits[1].result, "executed_verified");
});

test("budget call converts to minor units at the write and is clamped by the guard first", async () => {
  const mcp = fakeMcp();
  const audits: AuditEntry[] = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const { guardDeps, audit } = fakeGuardDeps(autoConfig(), audits);
  registerGatedWriteTools(mcp, { guardDeps, doerDeps: fakeDoerDeps(writes), audit });

  // baseline 100, request 140 -> guard clamps to 125 -> doer writes 12500 minor units
  const res = (await mcp.tools.adjust_adset_budget.cb({ entityId: "as_1", dailyBudget: 140 })) as { content: Array<{ text: string }> };
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.decision.allowed, true);
  assert.equal(payload.decision.effectiveArgs.dailyBudget, 125);
  assert.deepEqual(writes, [{ path: "/as_1", body: { daily_budget: 12500 } }]);
  assert.equal(payload.execution.verified, true);
});

test("extra fields from the model CANNOT smuggle past the schema (guard args are constructed)", async () => {
  const mcp = fakeMcp();
  const audits: AuditEntry[] = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const { guardDeps, audit } = fakeGuardDeps(autoConfig(), audits);
  registerGatedWriteTools(mcp, { guardDeps, doerDeps: fakeDoerDeps(writes), audit });

  // status:ACTIVE and account_id must be ignored — the handler builds the guard
  // args from named fields only, so the guard sees exactly {entityId, status:PAUSED}
  const res = (await mcp.tools.pause_entity.cb({ entityId: "as_1", status: "ACTIVE", account_id: "act_evil" })) as { content: Array<{ text: string }> };
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.decision.allowed, true);
  assert.deepEqual(writes, [{ path: "/as_1", body: { status: "PAUSED" } }]);
});

test("a malformed entityId is refused by the guard, not thrown", async () => {
  const mcp = fakeMcp();
  const audits: AuditEntry[] = [];
  const { guardDeps, audit } = fakeGuardDeps(autoConfig(), audits);
  registerGatedWriteTools(mcp, { guardDeps, doerDeps: fakeDoerDeps([]), audit });

  const res = (await mcp.tools.pause_entity.cb({})) as { content: Array<{ text: string }> };
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.decision.allowed, false);
  assert.equal(payload.decision.code, "args_entity");
});
