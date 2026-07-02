import { test } from "node:test";
import assert from "node:assert/strict";
import { createNeonSql } from "./sql.ts";

test("createNeonSql fails closed on a missing connection string", () => {
  assert.throws(() => createNeonSql(undefined), /connection string is missing/);
  assert.throws(() => createNeonSql(""), /connection string is missing/);
  assert.throws(() => createNeonSql("   "), /connection string is missing/);
});

test("createNeonSql returns an injectable Sql function for a non-empty string", () => {
  // neon() is lazy over HTTP — constructing does not connect, so a dummy URL is safe here.
  const sql = createNeonSql("postgres://user:pass@host/db");
  assert.equal(typeof sql, "function");
});
