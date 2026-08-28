// Run the REAL publisher code against REAL Meta with the REAL approved assets, and let it build a
// two-format creative — WITHOUT creating an ad.
//
//   npx tsx scripts/probe-two-format-real.ts --confirm
//
// WHY THIS EXISTS, when a probe already proved the shape:
// the earlier probe (app/scripts/probe-asset-feed-spec.js) sent a hand-written JSON body with its own
// fetch. Production does NOT do that. It goes through createPublisherGraph -> encodeGraphField, which
// JSON-stringifies every nested object into a FORM-ENCODED field, and then through MetaClient/axios.
// Whether an asset_feed_spec with nested images and asset_customization_rules survives THAT encoding
// was never tested. This runs the production path end to end instead of a lookalike:
//   * the real createMetaPublisher
//   * the real createPublisherGraph + MetaClient (so the real encoder and transport)
//   * the real createPublishDb (so the real compositions and the real bytea-decoded image bytes)
//
// SAFETY, by construction:
//   * /ads is INTERCEPTED and throws before the request is built. There is no code path here that can
//     create an ad, so nothing can deliver or spend. Images and creatives are inert on their own.
//   * The creative id is captured as it is created and DELETED in a `finally`.
//   * The ad set's ads are counted BEFORE and AFTER; a change is reported loudly.
//   * Nothing is consumed: consumeApproval is never called from this script.
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
// The gym creative approved on 26 Aug: square published as ad 52627564401820, vertical as the
// duplicate 52627764607820 that was deleted. Same words, same form, different image — exactly the
// pair this feature is for.
const SQUARE = "c3daea35b8f51817c511e6bc3e5ac7eca6e1e9ed18aa806ed4c304cf1809b955";
const VERTICAL = "a8c894bee8a29e19de28c7af9b779a340ec97ac03a47cda80708db8c3dc66e76";

const out = (s: string) => process.stdout.write(s + "\n");
const TOKEN = env.META_ACCESS_TOKEN || "";
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
    const data = (r as { data?: unknown[] }).data;
    return Array.isArray(data) ? data.length : null;
  };

  const before = await adCount();
  out(`ads in ad set BEFORE: ${before}`);

  const calls: string[] = [];
  let creativeId: string | null = null;
  let creativeBodyKeys: string[] = [];

  // The production graph, with ONE difference: the ad edge is refused. Everything else — the encoder,
  // the transport, the real uploads — is untouched.
  const graph = {
    get: realGraph.get,
    post: async (p: string, body: Record<string, unknown>) => {
      calls.push(p);
      if (/\/ads$/.test(p)) {
        out(`\n🛑 INTERCEPTED the ad create (${p}) — refusing, by design. No ad exists.`);
        throw new Error("probe: ad creation intentionally blocked");
      }
      if (p.includes("/adcreatives")) {
        creativeBodyKeys = Object.keys(body);
        // Prove the nested spec is really being sent, and that it survives the production encoder.
        const encodedSpec = body.asset_feed_spec;
        out(`\nPOST ${p}`);
        out(`  body fields: ${JSON.stringify(creativeBodyKeys)}`);
        out(`  asset_feed_spec type before encoding: ${typeof encodedSpec}`);
      }
      const res = await realGraph.post(p, body);
      if (p.includes("/adcreatives")) {
        const id = (res as { id?: unknown }).id;
        if (typeof id === "string") { creativeId = id; out("  creative CREATED (production encoder accepted the nested spec)"); }
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
      name: `AdPilot PROBE two-format [apx:${SQUARE}]`,
      approvalHash: SQUARE,
      companionHash: VERTICAL,
    });
    out("\n⚠️  createAd RETURNED — the /ads interceptor did not fire. Investigate immediately.");
    process.exitCode = 1;
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : e);
    if (msg.includes("intentionally blocked")) {
      out("\n✅ Reached the ad create and was blocked there, as designed.");
    } else {
      out(`\n❌ FAILED BEFORE the ad create: ${msg}`);
      out("   That is a REAL defect in the two-format path — read the message above.");
      process.exitCode = 1;
    }
  }

  try {
    out(`\ncalls made (in order): ${JSON.stringify(calls)}`);
    const uploads = calls.filter((c) => c.includes("/adimages")).length;
    const creatives = calls.filter((c) => c.includes("/adcreatives")).length;
    out(`  image uploads: ${uploads} (want 2)   creatives: ${creatives} (want 1)`);

    if (creativeId) {
      const back = await realGraph.get(`/${creativeId}?fields=id,name,asset_feed_spec,object_story_spec`);
      const afs = (back as { asset_feed_spec?: Record<string, unknown> }).asset_feed_spec;
      if (!afs) out("\n❌ read-back carried NO asset_feed_spec — accepted but not stored");
      else {
        const images = Array.isArray(afs.images) ? afs.images.length : 0;
        const rules = Array.isArray(afs.asset_customization_rules) ? afs.asset_customization_rules.length : 0;
        const json = JSON.stringify(afs);
        const formKept = json.includes("1034988492638399");
        // Meta NORMALISES the rules it stores: the default rule we send with an empty
        // customization_spec comes back carrying {age_min: 13, age_max: 65}, because Meta stamps age
        // bounds onto every spec. So "empty spec" is not the invariant — "no PLACEMENT constraint" is.
        // The catch-all is the rule that names no placement; it must carry the square.
        const PLACEMENT_KEYS = ["publisher_platforms", "facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions"];
        const ruleList = (Array.isArray(afs.asset_customization_rules) ? afs.asset_customization_rules : []) as Array<Record<string, any>>;
        const placementsOf = (r: Record<string, any>) => PLACEMENT_KEYS.filter((k) => Array.isArray(r?.customization_spec?.[k]) && r.customization_spec[k].length);
        const catchAll = ruleList.filter((r) => placementsOf(r).length === 0);
        const storyRule = ruleList.find((r) => (r?.customization_spec?.facebook_positions || []).includes("story"));
        const defaults = catchAll.length;
        const catchAllIsSquare = catchAll.length === 1 && catchAll[0]?.image_label?.name === "apx_square";
        const storyIsVertical = !!storyRule && storyRule.image_label?.name === "apx_vertical";
        out(`  catch-all rule (no placement constraint) carries the SQUARE: ${catchAllIsSquare ? "YES" : "NO"}`);
        out(`  story rule carries the VERTICAL:                            ${storyIsVertical ? "YES" : "NO"}`);
        if (process.argv.includes("--raw")) {
          out("\nRAW rules as Meta stored them:");
          out(JSON.stringify(afs.asset_customization_rules, null, 1).slice(0, 1400));
        }
        out("\nREAD BACK from Meta:");
        out(`  images stored:              ${images}  (want 2)`);
        out(`  asset_customization_rules:  ${rules}  (want 2)`);
        out(`  catch-all rules:            ${defaults}  (want exactly 1)`);
        out(`  LEAD FORM present:          ${formKept ? "YES" : "NO"}`);
        const ok = images === 2 && rules === 2 && defaults === 1 && formKept && catchAllIsSquare && storyIsVertical;
        out(`\nVERDICT: ${ok
          ? "the PRODUCTION code path builds a two-format creative Meta accepts, with the lead form intact."
          : "something did not survive — see above. Do NOT rely on this path yet."}`);
        if (!ok) process.exitCode = 1;
      }
    } else {
      out("\n(no creative was created, so there is nothing to read back)");
    }
  } finally {
    if (creativeId) {
      try {
        const del = await client.delete(`/${creativeId}`);
        out(`\ncleanup: DELETE creative -> ${JSON.stringify(del).slice(0, 120)}`);
      } catch (e) {
        out(`\n⚠️  cleanup FAILED for creative ${creativeId}: ${redact(e instanceof Error ? e.message : e)}`);
        out("   An orphan creative delivers nothing, but delete it by hand.");
      }
    }
    const after = await adCount();
    out(`ads in ad set AFTER: ${after}`);
    if (before !== null && after !== null && before !== after) {
      out(`🔴 AD COUNT MOVED ${before} -> ${after} — investigate immediately`);
      process.exitCode = 1;
    } else {
      out("ad count unchanged — no ad was created ✅");
    }
  }
}

main().catch((e) => { out("FAILED: " + redact(e instanceof Error ? e.message : e)); process.exitCode = 1; });
