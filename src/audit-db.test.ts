import { test } from "node:test";
import assert from "node:assert/strict";
import { createDbAuditSink } from "./audit-db.ts";
import type { AuditEntry } from "./audit.ts";

function fakeSql(handler: (text: string, params: unknown[]) => Record<string, unknown>[] = () => []) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sql = Object.assign(
    async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return handler(text, params);
    },
    { calls }
  );
  return sql;
}

const entry: AuditEntry = {
  ts: "2026-06-14T10:00:00.000Z",
  actor: "agent",
  action: "pause",
  entityId: "as_1",
  ruleTriggered: null,
  result: "approved_for_execution",
  details: { effectiveArgs: { entityId: "as_1", status: "PAUSED" } },
};

test("writes one parameterized row to audit_log with the entry ts preserved in the jsonb", async () => {
  const sql = fakeSql();
  await createDbAuditSink(sql).write(entry);
  assert.equal(sql.calls.length, 1);
  const { text, params } = sql.calls[0];
  assert.match(text, /INSERT INTO audit_log/i);
  assert.doesNotMatch(text, /\$\{|\+ /); // parameterized, never interpolated
  assert.equal(params[0], "agent");
  assert.equal(params[1], "pause");
  assert.equal(params[2], "as_1");
  assert.equal(params[3], null);
  assert.equal(params[4], "approved_for_execution");
  const details = JSON.parse(params[5] as string);
  assert.equal(details.ts, entry.ts); // decision-time ts kept even though the row ts is DB now()
  assert.deepEqual(details.effectiveArgs, entry.details.effectiveArgs);
});

test("a refusal writes ruleTriggered into rule_triggered", async () => {
  const sql = fakeSql();
  await createDbAuditSink(sql).write({ ...entry, ruleTriggered: "kill_switch_db", result: "refused", details: { reason: "frozen" } });
  assert.equal(sql.calls[0].params[3], "kill_switch_db");
  assert.equal(sql.calls[0].params[4], "refused");
});

test("a DB failure propagates (caller downgrades an unlogged allow to a refusal)", async () => {
  const sql = fakeSql(() => {
    throw new Error("db down");
  });
  await assert.rejects(() => createDbAuditSink(sql).write(entry), /db down/);
});
