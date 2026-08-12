/**
 * Deploy identity. package.json is the ONLY version source (a test pins it), and the
 * commit sha comes from Vercel's build env — so /health always answers the question
 * "which bundle is live?", which was unanswerable on 2026-08-12 and blocked a migration.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// src/ and dist/ sit at the same depth, so one relative path serves both.
const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
) as { version: string };

export const VERSION: string = pkg.version;

export function buildInfo(env: Record<string, string | undefined>): { version: string; commit: string } {
  const sha = typeof env.VERCEL_GIT_COMMIT_SHA === "string" ? env.VERCEL_GIT_COMMIT_SHA.trim() : "";
  return { version: VERSION, commit: sha === "" ? "unknown" : sha };
}
