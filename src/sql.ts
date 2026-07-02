/**
 * Real Postgres `sql` for the execution coordinator, backed by Neon's serverless
 * HTTP driver. Injected into createDbCoordinator so the guard/doer stay testable
 * with a fake and never reach a live DB in unit tests. Fail-closed: refuses to
 * construct without a connection string, rather than silently pointing at nothing.
 */
import { neon } from "@neondatabase/serverless";
import type { Sql } from "./coordinator-db.js";

export function createNeonSql(connectionString: string | undefined): Sql {
  if (typeof connectionString !== "string" || connectionString.trim() === "") {
    throw new Error(
      "createNeonSql: connection string is missing — refusing to construct a live DB client (fail-closed)"
    );
  }
  const client = neon(connectionString);
  return async (text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    const rows = await client.query(text, params);
    return rows as Record<string, unknown>[];
  };
}
