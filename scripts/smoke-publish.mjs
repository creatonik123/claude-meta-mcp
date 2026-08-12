#!/usr/bin/env node
// Publish smoke test — first-ever ad creation. Calls publish_approved_creative ONCE (literal tool
// name), only with --hash <approvalHash> --confirm. The ad is born PAUSED inside the PAUSED
// sandbox campaign. Verifies: guard payload, the created ad's status at Meta, and the consumption row.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { assessSurface, statusFromPayload } from "../dist/smoke-report.js";

const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")
  .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
for (const k of Object.keys(process.env)) if (!(k in env) || process.env[k]) env[k] = process.env[k] ?? env[k];

async function mcp(base, token, method, params) {
  const res = await fetch(`${base}/mcp`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const m = (await res.text()).match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`MCP ${method}: unparseable (HTTP ${res.status})`);
  const json = JSON.parse(m[0]);
  if (json.error) throw new Error(`MCP ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

const args = process.argv.slice(2);
const hash = args.includes("--hash") ? args[args.indexOf("--hash") + 1] : null;
const confirmed = args.includes("--confirm");
const base = (env.PUBLIC_URL || "").replace(/\/$/, "");
if (!base || !env.AUTH_TOKEN || !env.DATABASE_URL) { console.error("Missing PUBLIC_URL/AUTH_TOKEN/DATABASE_URL."); process.exit(2); }

const health = await (await fetch(`${base}/health`)).json();
console.log(`deployment: version=${health.version} commit=${health.commit}`);
const tools = (await mcp(base, env.AUTH_TOKEN, "tools/list")).tools.map((t) => t.name);
const surface = assessSurface(tools);
console.log(`write tools: ${surface.writeToolsPresent.join(", ") || "NONE"}`);
if (!surface.armed) { console.log(surface.summary); process.exit(1); }
if (!hash || !confirmed) { console.log("ARMED, not executing: pass --hash <approvalHash> --confirm."); process.exit(0); }

const result = await mcp(base, env.AUTH_TOKEN, "tools/call", {
  name: "publish_approved_creative", // literal on purpose
  arguments: { approvalHash: hash },
});
const body = JSON.parse(result?.content?.[0]?.text ?? "{}");
console.log(`publish_approved_creative -> ${JSON.stringify(body)}`);
const mapped = statusFromPayload(body);
console.log(`mapped status: ${JSON.stringify(mapped)}`);

// Independent verification: consumption row + the created ad's status straight from Meta.
const sql = neon(env.DATABASE_URL);
const cons = await sql`SELECT published_ref FROM approval_consumptions WHERE binding_hash = ${hash}`;
console.log(`consumption row: ${JSON.stringify(cons)}`);
const adId = cons[0]?.published_ref;
if (adId) {
  const ad = await (await fetch(`https://graph.facebook.com/v22.0/${adId}?fields=name,status,effective_status,adset_id&access_token=${env.META_ACCESS_TOKEN}`)).json();
  console.log(`AD AT META: ${JSON.stringify(ad)}`);
  const ok = ad.status === "PAUSED" && ad.adset_id === "52623318982820";
  console.log(ok ? "\nPASS: ad exists, BORN PAUSED, in the sandbox ad set, approval consumed. A$0." :
    "\nNOT A PASS: ad state unexpected — investigate before trusting the path.");
  process.exit(ok ? 0 : 1);
}
console.log("\nNOT A PASS (yet): no consumption row — read the payload above for which gate refused.");
process.exit(1);
