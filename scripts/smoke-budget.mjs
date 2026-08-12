#!/usr/bin/env node
/**
 * Zero-spend budget smoke test — first-ever execution of the budget write path.
 *
 * Calls adjust_adset_budget ONCE (tool name is a literal — this script can call nothing else),
 * only with BOTH --adset <id> AND --amount <aud> AND --confirm. The target lives inside the
 * PAUSED sandbox campaign, so the number changes but nothing can deliver or spend. The guard
 * still applies every clamp (±25% single change, 20%/day account, spend caps, baseline) — a
 * refusal here is the guard working, and the verdict reports which gate said no.
 *
 * Run: PUBLIC_URL=... node scripts/smoke-budget.mjs --adset 52623318982820 --amount 2.30 --confirm
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
    /* env vars must carry the values */
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
const adset = args.includes("--adset") ? args[args.indexOf("--adset") + 1] : null;
const amount = args.includes("--amount") ? Number(args[args.indexOf("--amount") + 1]) : null;
const confirmed = args.includes("--confirm");

const env = loadEnv();
const base = (env.PUBLIC_URL || "").replace(/\/$/, "");
if (!base || !env.AUTH_TOKEN) {
  console.error("Missing PUBLIC_URL or AUTH_TOKEN. Nothing was called.");
  process.exit(2);
}

const health = await (await fetch(`${base}/health`)).json();
console.log(`deployment: version=${health.version} commit=${health.commit}`);
const tools = (await mcp(base, env.AUTH_TOKEN, "tools/list")).tools.map((t) => t.name);
const surface = assessSurface(tools);
console.log(`tools: ${tools.length} · write tools: ${surface.writeToolsPresent.join(", ") || "NONE"}`);
if (!surface.armed) {
  console.log(surface.summary);
  process.exit(surface.inert ? 0 : 1);
}

if (!adset || !Number.isFinite(amount) || !confirmed) {
  console.log("ARMED, but not executing: pass --adset <id> --amount <aud> --confirm.");
  process.exit(0);
}
if (!env.DATABASE_URL) {
  console.error("Cannot verify audit rows without DATABASE_URL — refusing to run.");
  process.exit(2);
}

const sql = neon(env.DATABASE_URL);
const before = await auditCount(sql);
console.log(`audit rows before: ${before}`);

const result = await mcp(base, env.AUTH_TOKEN, "tools/call", {
  name: "adjust_adset_budget", // literal on purpose
  arguments: { entityId: adset, dailyBudget: amount },
});
const body = JSON.parse(result?.content?.[0]?.text ?? "{}");
console.log(`adjust_adset_budget -> ${JSON.stringify(body)}`);

const after = await auditCount(sql);
console.log(`audit rows after: ${after}`);

const verdict = judgeSmokeRun({ pauseResult: statusFromPayload(body), auditBefore: before, auditAfter: after });
console.log(`\n${verdict.summary}`);
process.exit(verdict.pass ? 0 : 1);
