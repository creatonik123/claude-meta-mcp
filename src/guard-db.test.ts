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

// Was "approvalByHash still fails closed (throws) — publish path deferred", which pinned the old stub.
// approvalByHash is now really wired (see guard-db-approval.test.ts), and this test was left passing for
// the WRONG reason: "x" is rejected by hash validation, not by a deferred publish path. Renamed to say
// what it actually asserts, so it cannot be mistaken for proof that publish is still disabled.
test("approvalByHash refuses a malformed hash before touching the database", async () => {
  const sql = fakeSql(() => []);
  await assert.rejects(() => createGuardDb(sql).approvalByHash("x"), /hash/i);
  assert.equal(sql.calls.length, 0, "a malformed hash must never reach the database");
});

test("schemaVersion returns the integer; null when missing or non-integer", async () => {
  assert.equal(await createGuardDb(fakeSql(() => [{ version: 1 }])).schemaVersion(), 1);
  assert.equal(await createGuardDb(fakeSql(() => [])).schemaVersion(), null);
  assert.equal(await createGuardDb(fakeSql(() => [{ version: 1.5 }])).schemaVersion(), null);
  assert.equal(await createGuardDb(fakeSql(() => [{ version: "x" }])).schemaVersion(), null);
});

test("startOfDayBudget reads the frozen snapshot; null when no row; coerces string numeric", async () => {
  const sql = fakeSql(() => [{ daily_budget: "100" }]);
  const db = createGuardDb(sql);
  assert.equal(await db.startOfDayBudget("as_1", "2026-06-28"), 100);
  assert.match(sql.calls[0].text, /from execution_budget_snapshots/i);
  assert.deepEqual(sql.calls[0].params, ["as_1", "2026-06-28"]);
  assert.equal(await createGuardDb(fakeSql(() => [])).startOfDayBudget("as_1", "2026-06-28"), null);
});

test("accountStartOfDayTotal sums the day; null when the SUM is NULL (no rows)", async () => {
  assert.equal(await createGuardDb(fakeSql(() => [{ total: "1500" }])).accountStartOfDayTotal("2026-06-28"), 1500);
  assert.equal(await createGuardDb(fakeSql(() => [{ total: null }])).accountStartOfDayTotal("2026-06-28"), null);
});

test("budgetBaseline30d returns the average anchored to the given day; null when there is no history", async () => {
  const sql = fakeSql(() => [{ avg: "120" }]);
  assert.equal(await createGuardDb(sql).budgetBaseline30d("as_1", "2026-06-28"), 120);
  // window is anchored to the passed account-tz day, never the DB server's clock
  assert.deepEqual(sql.calls[0].params, ["as_1", "2026-06-28"]);
  assert.doesNotMatch(sql.calls[0].text, /CURRENT_DATE/i);
  // pin the window shape: trailing 30 days, STRICTLY before the anchor day
  // (the anchor day's own snapshot is the value under judgment — including it
  // would self-referentially raise the creep ceiling)
  assert.match(sql.calls[0].text, /day < \$2::date/);
  assert.match(sql.calls[0].text, /INTERVAL '30 days'/);
  assert.equal(await createGuardDb(fakeSql(() => [{ avg: null }])).budgetBaseline30d("as_1", "2026-06-28"), null);
});

test("accountStartOfDayTotal sums exactly the given day (query shape pinned)", async () => {
  const sql = fakeSql(() => [{ total: "1500" }]);
  assert.equal(await createGuardDb(sql).accountStartOfDayTotal("2026-06-28"), 1500);
  assert.match(sql.calls[0].text, /WHERE day = \$1/);
  assert.deepEqual(sql.calls[0].params, ["2026-06-28"]);
  assert.doesNotMatch(sql.calls[0].text, /CURRENT_DATE/i);
});

test("malformed values from the DB coerce to null (guard then refuses fail-safe)", async () => {
  assert.equal(await createGuardDb(fakeSql(() => [{ daily_budget: "abc" }])).startOfDayBudget("as_1", "2026-06-28"), null);
  assert.equal(await createGuardDb(fakeSql(() => [{ total: "NaN" }])).accountStartOfDayTotal("2026-06-28"), null);
  assert.equal(await createGuardDb(fakeSql(() => [{ avg: "Infinity" }])).budgetBaseline30d("as_1", "2026-06-28"), null);
  assert.equal(await createGuardDb(fakeSql(() => [{ active: "t" }])).killSwitchRow(), null); // non-boolean -> unknown -> frozen
});

// Every (table, column) the guard itself reads, as the app's migrations create them.
const PRESENT = [
  ["kill_switch", "active"],
  ["guard_schema_version", "version"],
  ["approval_records", "binding_hash"],
  ["approval_records", "target_entity_id"],
  ["approval_consumptions", "binding_hash"],
  ["approval_consumptions", "published_ref"],
  ["approval_consumptions", "consumed_at"],
  ["execution_budget_snapshots", "daily_budget"],
].map(([table_name, column_name]) => ({ table_name, column_name }));

test("missingSchema returns [] when every required table and column is present", async () => {
  const sql = fakeSql(() => PRESENT);
  assert.deepEqual(await createGuardDb(sql).missingSchema(), []);
  assert.match(sql.calls[0].text, /information_schema\.columns/i);
});

test("missingSchema names a whole missing table once, not each of its columns", async () => {
  const db = createGuardDb(fakeSql(() => PRESENT.filter((r) => r.table_name !== "approval_consumptions")));
  assert.deepEqual(await db.missingSchema(), ["approval_consumptions"]);
});

test("missingSchema names a missing column as table.column", async () => {
  const db = createGuardDb(fakeSql(() => PRESENT.filter((r) => r.column_name !== "target_entity_id")));
  assert.deepEqual(await db.missingSchema(), ["approval_records.target_entity_id"]);
});

test("missingSchema throws on a malformed row rather than guessing", async () => {
  const db = createGuardDb(fakeSql(() => [...PRESENT, { table_name: 7, column_name: null }]));
  await assert.rejects(() => db.missingSchema(), /unreadable/i);
});
