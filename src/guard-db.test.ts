import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuardDb } from "./guard-db.ts";

function fakeSql(handler: (text: string, params: unknown[]) => Record<string, unknown>[]) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sql = Object.assign(async (text: string, params: unknown[] = []) => { calls.push({ text, params }); return handler(text, params); }, { calls });
  return sql;
}

test("killSwitchRow returns false when the row is active=false (not frozen)", async () => {
  const sql = fakeSql(() => [{ active: false }]);
  const db = createGuardDb(sql);
  assert.equal(await db.killSwitchRow(), false);
  assert.match(sql.calls[0].text, /from kill_switch/i);
});

test("killSwitchRow returns true when active=true (frozen)", async () => {
  const db = createGuardDb(fakeSql(() => [{ active: true }]));
  assert.equal(await db.killSwitchRow(), true);
});

test("killSwitchRow returns null when the row is missing (guard treats null as frozen)", async () => {
  const db = createGuardDb(fakeSql(() => []));
  assert.equal(await db.killSwitchRow(), null);
});

test("the not-yet-wired reads fail closed (throw) so the guard refuses rather than guesses", async () => {
  const db = createGuardDb(fakeSql(() => []));
  await assert.rejects(() => db.approvalByHash("x"));
  await assert.rejects(() => db.startOfDayBudget("e", "2026-06-28"));
  await assert.rejects(() => db.accountStartOfDayTotal("2026-06-28"));
  await assert.rejects(() => db.budgetBaseline30d("e"));
  await assert.rejects(() => db.schemaVersion());
});
