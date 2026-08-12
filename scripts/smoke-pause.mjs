#!/usr/bin/env node
/**
 * Zero-spend pause smoke test — the supervised first-ever execution of the write path.
 *
 * WHAT IT DOES (and ALL it does):
 *   Phase A (always): GET /health (version + commit), POST tools/list, and report whether the
 *     deployment is INERT (no write tools — today's state), ARMED (all three), or PARTIAL (error).
 *   Phase B (only when ARMED and BOTH --entity <ad_id> AND --confirm are given): counts execute_*
 *     audit rows, calls pause_entity ONCE for that entity, re-counts, and prints a pass/fail
 *     verdict via src/smoke-report.ts. Pausing a paused-campaign's ad delivers nothing and costs
 *     A$0; pause is idempotent, so even a re-run cannot double-write.
 *
 * WHAT IT CANNOT DO, BY CONSTRUCTION:
 *   - flip any flag or env var (switch-on is a human's click in Vercel, never this script's);
 *   - call adjust_adset_budget or publish_approved_creative (the tool name is a literal below);
 *   - print a secret (it reads .env for connection values and prints results only).
 *
 * Run from the repo root:  node scripts/smoke-pause.mjs [--entity <ad_id> --confirm]
 * Env (or .env in repo root): PUBLIC_URL, AUTH_TOKEN, DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { assessSurface, judgeSmokeRun, statusFromPayload } from "../dist/smoke-report.js";

function loadEnv() {
  const out = { ...process.env };
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      if (!(k in out)) out[k] = t.slice(i + 1).trim();
    }
  } catch {
    /* no .env — env vars must carry the values */
  }
  return out;
}

async function mcp(base, token, method, params) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`MCP ${method}: unparseable response (HTTP ${res.status})`);
  const json = JSON.parse(m[0]);
  if (json.error) throw new Error(`MCP ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

// The count the verdict is judged against — same MAYBE_WROTE semantics as the app's daily cap.
async function auditCount(sql) {
  try {
    const rows = await sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE action IN ('pause','adjust_adset_budget','publish_approved_creative')`;
    return rows[0]?.n ?? null;
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const entityIdx = args.indexOf("--entity");
const entity = entityIdx >= 0 ? args[entityIdx + 1] : null;
const confirmed = args.includes("--confirm");

const env = loadEnv();
const base = (env.PUBLIC_URL || "").replace(/\/$/, "");
if (!base || !env.AUTH_TOKEN) {
  console.error("Missing PUBLIC_URL or AUTH_TOKEN (env or .env). Nothing was called.");
  process.exit(2);
}

// ---- Phase A ----------------------------------------------------------------
const health = await (await fetch(`${base}/health`)).json();
console.log(`deployment: version=${health.version} commit=${health.commit ?? "(endpoint predates commit field)"}`);

const tools = (await mcp(base, env.AUTH_TOKEN, "tools/list")).tools.map((t) => t.name);
const surface = assessSurface(tools);
console.log(`tools: ${tools.length} registered · write tools: ${surface.writeToolsPresent.join(", ") || "NONE"}`);
console.log(surface.summary);

if (!surface.armed) process.exit(surface.inert ? 0 : 1);

// ---- Phase B ----------------------------------------------------------------
if (!entity || !confirmed) {
  console.log("\nARMED, but not executing: pass BOTH --entity <ad_id> AND --confirm to run the one pause.");
  process.exit(0);
}
if (!env.DATABASE_URL) {
  console.error("ARMED but DATABASE_URL is missing — cannot verify audit rows, refusing to run.");
  process.exit(2);
}

const sql = neon(env.DATABASE_URL);
const before = await auditCount(sql);
console.log(`\naudit execute_* rows before: ${before}`);

const result = await mcp(base, env.AUTH_TOKEN, "tools/call", {
  name: "pause_entity", // literal on purpose — this script can never call any other tool
  arguments: { entityId: entity },
});
const body = JSON.parse(result?.content?.[0]?.text ?? "{}");
console.log(`pause_entity -> ${JSON.stringify(body)}`);

const after = await auditCount(sql);
console.log(`audit execute_* rows after: ${after}`);

const verdict = judgeSmokeRun({ pauseResult: statusFromPayload(body), auditBefore: before, auditAfter: after });
console.log(`\n${verdict.summary}`);
process.exit(verdict.pass ? 0 : 1);
