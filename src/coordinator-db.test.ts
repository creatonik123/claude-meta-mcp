import { test } from "node:test";
import assert from "node:assert/strict";
import { createDbCoordinator, type Sql } from "./coordinator-db.ts";

// Fake sql: returns whatever the handler gives, records every (text, params) call.
function fakeSql(handler: (text: string, params: unknown[]) => Record<string, unknown>[]) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sql: Sql & { calls: typeof calls } = Object.assign(
    async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return handler(text, params);
    },
    { calls: [] as typeof calls }
  );
  sql.calls = calls;
  return sql;
}

const HOLDER = "run-2026-06-26";

test("acquire returns true when the upsert returns our holder (lock taken)", async () => {
  const sql = fakeSql(() => [{ holder: HOLDER }]);
  const coord = createDbCoordinator(sql, HOLDER);
  assert.equal(await coord.acquire("23890"), true);
  assert.match(sql.calls[0].text, /execution_locks/i);
  assert.equal(sql.calls[0].params[0], "23890");
  assert.equal(sql.calls[0].params[1], HOLDER);
});

test("acquire returns false when the lock is held by someone else (no row returned)", async () => {
  const sql = fakeSql(() => []);
  const coord = createDbCoordinator(sql, HOLDER);
  assert.equal(await coord.acquire("23890"), false);
});

test("acquire returns false if the row comes back held by a DIFFERENT holder (defensive)", async () => {
  const sql = fakeSql(() => [{ holder: "some-other-run" }]);
  const coord = createDbCoordinator(sql, HOLDER);
  assert.equal(await coord.acquire("23890"), false);
});

test("alreadyApplied is scoped to THIS run (dedupe_key AND holder) so a later run can re-apply", async () => {
  const sql = fakeSql(() => [{ "?column?": 1 }]);
  const coord = createDbCoordinator(sql, HOLDER);
  assert.equal(await coord.alreadyApplied("pause:/23890:{}"), true);
  assert.match(sql.calls[0].text, /where dedupe_key = \$1 and holder = \$2/i);
  assert.deepEqual(sql.calls[0].params, ["pause:/23890:{}", HOLDER]);
});

test("alreadyApplied: false when this run has no matching row", async () => {
  const coord = createDbCoordinator(fakeSql(() => []), HOLDER);
  assert.equal(await coord.alreadyApplied("pause:/23890:{}"), false);
});

test("markApplied inserts the dedupe key scoped to the holder, conflicting on (key, holder)", async () => {
  const sql = fakeSql(() => []);
  const coord = createDbCoordinator(sql, HOLDER);
  await coord.markApplied("pause:/23890:{}");
  assert.match(sql.calls[0].text, /insert into execution_applied/i);
  assert.match(sql.calls[0].text, /on conflict \(dedupe_key, holder\)/i);
  assert.deepEqual(sql.calls[0].params, ["pause:/23890:{}", HOLDER]);
});

test("release deletes only our own lock (scoped to lock_key AND holder)", async () => {
  const sql = fakeSql(() => []);
  const coord = createDbCoordinator(sql, HOLDER);
  await coord.release("23890");
  assert.match(sql.calls[0].text, /delete from execution_locks/i);
  assert.deepEqual(sql.calls[0].params, ["23890", HOLDER]);
});

test("a sql error on acquire propagates (so the doer fails closed)", async () => {
  const sql = fakeSql(() => { throw new Error("connection lost"); });
  const coord = createDbCoordinator(sql, HOLDER);
  await assert.rejects(() => coord.acquire("23890"), /connection lost/);
});
