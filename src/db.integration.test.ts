/**
 * LIVE DB integration — runs ONLY against the Neon test branch (TEST_DATABASE_URL),
 * and refuses if that equals DATABASE_URL. Skips entirely when TEST_DATABASE_URL is
 * unset, so the normal unit run (no --env-file) never touches a real DB.
 * Run: node --import tsx --env-file=../.env --test "src/db.integration.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "@neondatabase/serverless";
import { createNeonSql } from "./sql.ts";
import { createGuardDb } from "./guard-db.ts";

const TEST_URL = process.env.TEST_DATABASE_URL;
const PROD_URL = process.env.DATABASE_URL;
// Skip ONLY when unset. TEST_URL === PROD_URL is a misconfiguration and must FAIL
// loudly (the assert below fires before any connection), never skip silently.
const skip = TEST_URL ? false : "TEST_DATABASE_URL unset — skipping live DB test";

test("DB integration (test branch): migrations apply + guard-db reads", { skip }, async (t) => {
  assert.notEqual(TEST_URL, PROD_URL, "TEST_DATABASE_URL must never equal DATABASE_URL");

  // Migrations are multi-statement DDL — apply via Pool (pg protocol). Idempotent.
  const pool = new Pool({ connectionString: TEST_URL });
  try {
    for (const f of ["0001_execution_coordinator.sql", "0002_guard_snapshots.sql"]) {
      const ddl = readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8");
      await pool.query(ddl);
    }
  } finally {
    await pool.end();
  }

  const sql = createNeonSql(TEST_URL);
  const db = createGuardDb(sql);

  await t.test("guard_schema_version seeded to 1", async () => {
    assert.equal(await db.schemaVersion(), 1);
  });

  await t.test("budget snapshot round-trips through the guard reads", async () => {
    const eid = "it_as_20200101";
    const day = "2020-01-01"; // fixed far-past day, unique to this test — won't collide with real snapshots
    await sql(`DELETE FROM execution_budget_snapshots WHERE entity_id = $1`, [eid]);
    await sql(
      `INSERT INTO execution_budget_snapshots (entity_id, day, daily_budget) VALUES ($1, $2, $3)`,
      [eid, day, 100]
    );
    assert.equal(await db.startOfDayBudget(eid, day), 100);
    const total = await db.accountStartOfDayTotal(day);
    assert.ok(total !== null && total >= 100, `account SoD total should include the snapshot (got ${total})`);
    // trailing-30d creep baseline EXCLUDES the anchor day's own snapshot...
    assert.equal(await db.budgetBaseline30d(eid, day), null);
    // ...and sees it from the next day's anchor
    assert.equal(await db.budgetBaseline30d(eid, "2020-01-02"), 100);
    await sql(`DELETE FROM execution_budget_snapshots WHERE entity_id = $1`, [eid]);
    assert.equal(await db.startOfDayBudget(eid, day), null); // cleaned up
  });
});
