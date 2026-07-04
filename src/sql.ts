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
  // The driver's own "not a valid URL" error echoes the full connection string
  // (credentials included) into whatever catches it — e.g. the fatal boot log.
  // Catch and rethrow with the value redacted; never let the secret escape.
  let client: ReturnType<typeof neon>;
  try {
    client = neon(connectionString);
  } catch {
    throw new Error(
      "createNeonSql: connection string is not a valid Postgres URL (value redacted) — refusing to construct a live DB client (fail-closed)"
    );
  }
  return async (text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    const rows = await client.query(text, params);
    return rows as Record<string, unknown>[];
  };
}
