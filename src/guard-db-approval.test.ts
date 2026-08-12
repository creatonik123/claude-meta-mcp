import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuardDb } from "./guard-db.ts";

// approvalByHash — the guard's read of the human's signature.
//
// It was a stub that threw unconditionally, so publish refused with approval_unreadable and the
// publish path could never complete. Its stated reason ("approval_records has no consumed column") was
// also wrong: that column exists, but an append-only trigger on the table means it can never be
// WRITTEN, so consumption lives in its own table (app migration 0011).
//
// THE ASYMMETRY THAT DRIVES EVERY CHOICE HERE: `consumed: false` is the ONLY value that lets a publish
// proceed (guard.ts refuses on anything else). So every uncertainty must resolve to "not false" or to a
// throw — never to false. A row we cannot read correctly must never look like a fresh, usable approval.

function fakeSql(handler: (text: string, params: unknown[]) => Record<string, unknown>[] = () => []) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sql = Object.assign(
    async (text: string, params: unknown[] = []) => { calls.push({ text, params }); return handler(text, params); },
    { calls }
  );
  return sql;
}

const HASH = "a".repeat(64);
const row = (over: Record<string, unknown> = {}) => [{ target: "120200999888", consumed_count: 0, ...over }];

test("an approval that exists and is unused returns consumed:false with its target", async () => {
  const db = createGuardDb(fakeSql(() => row()));
  assert.deepEqual(await db.approvalByHash(HASH), { consumed: false, targetEntityId: "120200999888" });
});

test("the hash is passed as a BOUND PARAMETER, never interpolated", async () => {
  const sql = fakeSql(() => row());
  await createGuardDb(sql).approvalByHash(HASH);
  const q = sql.calls[0];
  assert.deepEqual(q.params, [HASH]);
  assert.doesNotMatch(q.text, new RegExp(HASH), "the hash must not appear inside the SQL text");
});

test("it reads BOTH tables — the signature and whether it was already spent", async () => {
  const sql = fakeSql(() => row());
  await createGuardDb(sql).approvalByHash(HASH);
  const t = sql.calls[0].text;
  assert.match(t, /approval_records/, "must read the approval");
  assert.match(t, /approval_consumptions/, "must check whether it was consumed");
});

test("no approval row => null, so the guard refuses approval_missing", async () => {
  assert.equal(await createGuardDb(fakeSql(() => [])).approvalByHash(HASH), null);
});

test("an approval already consumed returns consumed:true", async () => {
  const db = createGuardDb(fakeSql(() => row({ consumed_count: 1 })));
  const r = await db.approvalByHash(HASH);
  assert.equal(r?.consumed, true, "a spent approval must never read as usable");
});

test("FAIL-CLOSED: an unreadable consumption count THROWS rather than reading as unused", async () => {
  // The whole point. `consumed: false` is the only value that permits a publish, and drivers can
  // return counts as strings, nulls or NaN. Defaulting any of those to false would let a
  // one-time-use approval be spent twice.
  for (const bad of [null, undefined, "", "abc", NaN, {}, [], true]) {
    const db = createGuardDb(fakeSql(() => row({ consumed_count: bad })));
    await assert.rejects(() => db.approvalByHash(HASH), /consum/i, `consumed_count=${JSON.stringify(bad)}`);
  }
});

test("a count arriving as a NUMERIC STRING is still understood", async () => {
  // Postgres count() legitimately arrives as a string over some drivers; that is not corruption.
  assert.equal((await createGuardDb(fakeSql(() => row({ consumed_count: "0" }))).approvalByHash(HASH))?.consumed, false);
  assert.equal((await createGuardDb(fakeSql(() => row({ consumed_count: "2" }))).approvalByHash(HASH))?.consumed, true);
});

test("a negative or fractional count is nonsense and THROWS", async () => {
  for (const bad of [-1, 0.5, "-3"]) {
    const db = createGuardDb(fakeSql(() => row({ consumed_count: bad })));
    await assert.rejects(() => db.approvalByHash(HASH), /consum/i, String(bad));
  }
});

test("an unusable target yields null, so the guard refuses approval_no_target", async () => {
  // Never coerced: the guard compares the target as a trimmed string, and a number that stringifies
  // differently would miss the campaign allowlist silently.
  for (const bad of [null, undefined, "", "   ", 120200999888, {}, []]) {
    const db = createGuardDb(fakeSql(() => row({ target: bad })));
    const r = await db.approvalByHash(HASH);
    assert.equal(r?.targetEntityId, null, JSON.stringify(bad));
    assert.equal(r?.consumed, false, "an absent target must not also corrupt the consumed flag");
  }
});

test("the target is trimmed, matching how the guard compares it", async () => {
  const db = createGuardDb(fakeSql(() => row({ target: "  120200999888  " })));
  assert.equal((await db.approvalByHash(HASH))?.targetEntityId, "120200999888");
});

test("an unusable hash argument refuses BEFORE touching the database", async () => {
  const sql = fakeSql(() => row());
  const db = createGuardDb(sql);
  for (const bad of ["", "   ", "not-a-hash", "A".repeat(64), "a".repeat(63)]) {
    await assert.rejects(() => db.approvalByHash(bad), /hash/i, JSON.stringify(bad));
  }
  assert.equal(sql.calls.length, 0, "a malformed hash must not reach the database");
});

test("a database error propagates, so the guard fails closed as approval_unreadable", async () => {
  const db = createGuardDb(fakeSql(() => { throw new Error("connection reset"); }));
  await assert.rejects(() => db.approvalByHash(HASH));
});
