/**
 * PUBLISH REHEARSAL THAT STOPS AT THE FIRST WRITE. Runs the guard's REAL publish path — approval and
 * composition reads from the database, image bytes, search-before-create against Meta (GET), the
 * planner, the publisher — with a `post` that records the exact write it was about to send and THROWS.
 * Nothing is uploaded, no creative or ad is created, no approval is consumed, no lock is taken.
 * No `validate_only` either: on 2026-09-04 Meta honoured a budget write despite that flag.
 *
 *   PUBLIC_URL unused. Needs DATABASE_URL + META_ACCESS_TOKEN (+ META_API_VERSION) in the guard .env.
 *   npx tsx scripts/rehearse-publish-stop.ts <approvalHash> <adsetId>
 */
import { readFileSync } from "node:fs";
import { createNeonSql } from "../src/sql.ts";
import { MetaClient } from "../src/meta-client.ts";
import { createPublisherGraph } from "../src/meta-adapters.ts";
import { createPublishDb } from "../src/publish-db.ts";
import { createMetaPublisher } from "../src/meta-publisher.ts";
import { decidePublish } from "../src/publish-plan.ts";
import { createGuardDb } from "../src/guard-db.ts";
import { evaluate } from "../src/guard.ts";
import { loadGuardConfig } from "../src/load-config.ts";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}
const [hash, adsetId] = process.argv.slice(2);
if (!/^[0-9a-f]{64}$/.test(hash ?? "") || !adsetId) throw new Error("usage: <approvalHash> <adsetId>");

class Stop extends Error {}
const config = loadGuardConfig();
const sql = createNeonSql(process.env.DATABASE_URL);
const client = new MetaClient(process.env.META_ACCESS_TOKEN as string, process.env.META_API_VERSION ?? "v22.0");
const graph = createPublisherGraph(client);
const publishDb = createPublishDb(sql);
const guardDb = createGuardDb(sql);
const writes: Array<{ path: string; keys: string[]; summary: string }> = [];

const publisher = createMetaPublisher({
  accountId: config.managedAccountId,
  get: graph.get,
  post: async (path, body) => {
    const keys = Object.keys(body ?? {});
    const summary = path.endsWith("/adimages") ? `image ${Math.round(String((body as { bytes?: string }).bytes ?? "").length * 0.75 / 1024)} KB` : JSON.stringify(body).slice(0, 200);
    writes.push({ path, keys, summary });
    throw new Stop(`STOP — the next step would write to Meta: POST ${path}`);
  },
  readComposition: (h) => publishDb.readComposition(h),
  readAsset: (s) => publishDb.readAsset(s),
});

(async () => {
  // 1. The guard's own decision for this publish (kill switch, mode, approval, campaign scope) — reads only.
  const meta = {
    entityAccountId: async (id: string) => String(((await client.get<{ account_id?: string }>(`/${id}`, { fields: "account_id" })).account_id) ?? ""),
    entityCampaignId: async (id: string) => String(((await client.get<{ campaign_id?: string }>(`/${id}`, { fields: "campaign_id" })).campaign_id) ?? ""),
    currentBudget: async () => null, realisedSpend: async () => null, accountActiveDailyBudgetTotal: async () => null,
  };
  const decision = await evaluate("publish_approved_creative", { approvalHash: hash }, { config, now: () => new Date(), env: process.env, db: guardDb, meta });
  console.log("guard decision:", JSON.stringify(decision));
  if (!decision.allowed) return;

  // 2. Destination + form + page, as Meta sees them today (GET).
  const adset = await client.get<Record<string, unknown>>(`/${adsetId}`, { fields: "name,status,effective_status,campaign_id,account_id,learning_stage_info" });
  console.log("ad set:", JSON.stringify(adset));
  const comp = await publishDb.readComposition(hash);
  if (!comp) throw new Error("no composition");
  const page = await client.get<Record<string, unknown>>(`/${comp.page_id}`, { fields: "id,name" });
  console.log("page:", JSON.stringify(page));
  if (comp.lead_gen_form_id) {
    const form = await client.get<Record<string, unknown>>(`/${comp.lead_gen_form_id}`, { fields: "id,name,status,page{id}" });
    console.log("lead form:", JSON.stringify(form));
  }
  const asset = await publishDb.readAsset(comp.asset_sha256);
  console.log("image bytes:", asset ? `${asset.bytes.length} bytes ${asset.mime}` : "MISSING", "| headline:", comp.headline, "| cta:", comp.cta);

  // 3. Search-before-create (GET) and the plan the doer would act on.
  const plan = await decidePublish({ bindingHash: hash, adsetId }, { searchAdsInAdset: publisher.searchAdsInAdset });
  console.log("plan:", JSON.stringify(plan));
  if (plan.decision !== "create") return;

  // 4. The publisher itself, up to the first write.
  try {
    await publisher.createAd({ adsetId: plan.adsetId!, name: plan.adName!, approvalHash: hash });
    console.log("UNEXPECTED: createAd returned without a write");
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    console.log(String(e.message));
  }
  console.log("writes attempted (recorded, NOT sent):", JSON.stringify(writes));
  console.log("order the real run would follow: POST /adimages → POST /adcreatives → POST /ads (status PAUSED) → activate_ad");
})().catch((e) => { console.error("FAIL", e instanceof Error ? e.message : e); process.exit(1); });
