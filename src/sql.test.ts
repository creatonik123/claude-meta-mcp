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

test("createNeonSql never echoes the connection string (credentials) in its error", () => {
  // Common paste mistakes that make the driver throw its URL-echoing error:
  // surrounding quotes, whitespace inside the URL, bad percent-encoding.
  const secrets = [
    '"postgres://user:hunter2pass@host/db"',
    "postgres://user:hunter2pass@ho st/db",
    "postgres://user:hunter2%zzpass@host/db",
  ];
  let threw = 0;
  for (const conn of secrets) {
    let thrown: unknown;
    try {
      createNeonSql(conn);
    } catch (e) {
      thrown = e;
    }
    if (thrown === undefined) continue; // driver accepted it — nothing to leak
    threw++;
    const msg = String((thrown as Error).message) + String((thrown as Error).stack ?? "");
    assert.ok(!msg.includes("hunter2pass"), `error text leaked the credential for input shape: ${conn.slice(0, 12)}...`);
    assert.match(String((thrown as Error).message), /redacted/);
  }
  // If a future driver accepts every malformed shape, this pin must fail
  // loudly rather than pass while asserting nothing.
  assert.ok(threw > 0, "no input reached the throw path — the redaction pin is vacuous; update the malformed shapes");
});
