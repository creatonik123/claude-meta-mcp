// WHY does /ads refuse a two-format creative? Capture Meta's FULL error payload.
//
//   npx tsx scripts/probe-ads-error.ts --confirm
//
// The smoke run surfaced only "Meta Graph API error 100: Invalid parameter", which names nothing
// actionable. Meta's payload usually carries error_subcode / error_user_title / error_user_msg, and
// those are what say WHICH parameter. This makes exactly that one call and prints all of it.
//
// SAFETY:
//   * It builds the creative through the REAL publisher path, then makes ONE /ads attempt.
//   * If an ad IS created it is DELETED first (an ad is the only object that can deliver), then the
//     creative. Both in a `finally`.
//   * The ad set's ads are counted before and after and any change is reported loudly.
//   * A created ad would be PAUSED — createMetaPublisher has no code path that emits ACTIVE.
//   * Requires --confirm.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMetaPublisher } from "../src/meta-publisher.js";
import { createPublisherGraph } from "../src/meta-adapters.js";
import { createPublishDb } from "../src/publish-db.js";
import { createNeonSql } from "../src/sql.js";
import { MetaClient } from "../src/meta-client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const line of fs.readFileSync(path.join(HERE, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const ACCOUNT = "act_2218833115522041";
const ADSET = "52623496198620";
const SQUARE = "c3daea35b8f51817c511e6bc3e5ac7eca6e1e9ed18aa806ed4c304cf1809b955";
const VERTICAL = "a8c894bee8a29e19de28c7af9b779a340ec97ac03a47cda80708db8c3dc66e76";

const TOKEN = env.META_ACCESS_TOKEN || "";
const out = (s: string) => process.stdout.write(s + "\n");
const redact = (s: unknown) => {
  const t = String(s ?? "");
  return TOKEN ? t.split(TOKEN).join("<token>") : t;
};

async function main() {
  if (!process.argv.includes("--confirm")) { out("refusing to run without --confirm"); process.exitCode = 1; return; }
  if (!TOKEN || !env.DATABASE_URL) { out("missing META_ACCESS_TOKEN or DATABASE_URL"); process.exitCode = 1; return; }

  const sql = createNeonSql(env.DATABASE_URL);
  const publishDb = createPublishDb(sql);
  const client = new MetaClient(TOKEN, env.META_API_VERSION || "v22.0");
  const realGraph = createPublisherGraph(client);

  const adCount = async () => {
    const r = await realGraph.get(`/${ADSET}/ads?fields=id&limit=200`);
    const d = (r as { data?: unknown[] }).data;
    return Array.isArray(d) ? d.length : null;
  };

  const before = await adCount();
  out(`ads BEFORE: ${before}`);

  let creativeId: string | null = null;
  let adId: string | null = null;

  const graph = {
    get: realGraph.get,
    post: async (p: string, body: Record<string, unknown>) => {
      const res = await realGraph.post(p, body);
      if (p.includes("/adcreatives")) {
        const id = (res as { id?: unknown }).id;
        if (typeof id === "string") { creativeId = id; out(`creative created: ${id}`); }
      }
      if (/\/ads$/.test(p)) {
        const id = (res as { id?: unknown }).id;
        if (typeof id === "string") { adId = id; out(`⚠️  AD CREATED: ${id} — deleted below`); }
      }
      return res;
    },
  };

  const publisher = createMetaPublisher({
    accountId: ACCOUNT,
    post: graph.post,
    get: graph.get,
    readComposition: (h: string) => publishDb.readComposition(h),
    readAsset: (s: string) => publishDb.readAsset(s),
  });

  try {
    await publisher.createAd({
      adsetId: ADSET,
      name: `AdPilot PROBE ads-error [apx:${SQUARE}]`,
      approvalHash: SQUARE,
      companionHash: VERTICAL,
    });
    out("\n✅ /ads SUCCEEDED with a two-format creative — the ad exists and is deleted below.");
  } catch (e) {
    const err = e as { meta?: unknown; message?: string; httpStatus?: number };
    out(`\n❌ /ads REFUSED — httpStatus ${err.httpStatus ?? "?"}`);
    out("FULL META PAYLOAD:");
    out(redact(JSON.stringify(err.meta ?? { message: err.message }, null, 1)).slice(0, 2500));
  } finally {
    if (adId) {
      try { out(`\ncleanup: DELETE ad -> ${JSON.stringify(await client.delete(`/${adId}`)).slice(0, 80)}`); }
      catch (e) { out(`\n🔴 DELETE AD FAILED (${adId}): ${redact(e instanceof Error ? e.message : e)} — REMOVE BY HAND`); process.exitCode = 1; }
    }
    if (creativeId) {
      try { out(`cleanup: DELETE creative -> ${JSON.stringify(await client.delete(`/${creativeId}`)).slice(0, 80)}`); }
      catch (e) { out(`⚠️  creative ${creativeId} not deleted: ${redact(e instanceof Error ? e.message : e)}`); }
    }
    const after = await adCount();
    out(`ads AFTER: ${after}`);
    if (before !== null && after !== null && before !== after) { out(`🔴 AD COUNT MOVED ${before} -> ${after}`); process.exitCode = 1; }
    else out("ad count unchanged ✅");
  }
}

main().catch((e) => { out("FAILED: " + redact(e instanceof Error ? e.message : e)); process.exitCode = 1; });
