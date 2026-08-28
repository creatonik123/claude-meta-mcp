import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetaPublisher } from "./meta-publisher.ts";
import type { MetaPublisherDeps } from "./meta-publisher.ts";

// ONE ad carrying BOTH renderings — the square in feed, the vertical in stories/reels — instead of two
// separate ads. The approver approved one ad; they must get one ad.
//
// THE SHAPE HERE IS NOT INVENTED. It was proven against the live account on 2026-08-28 by
// app/scripts/probe-asset-feed-spec.js (creative created then deleted, no ad, ad count unchanged).
// Two rejections shaped it, and both are load-bearing:
//   * code 100 / subcode 1885923 — a DEFAULT rule with an EMPTY customization_spec is REQUIRED as the
//     catch-all, and it carries the square (the rendering the approval card previews).
//   * code 100 / subcode 2446501 "Invalid Targeting Rule For Localization By Location Ad" — labelling
//     and referencing five asset types (image/body/title/link/CTA) per rule puts the creative into
//     the location-localization mode, which then demands geo in every rule. ONLY THE IMAGE MAY VARY.
// The lead form survived the round trip inside call_to_actions, verified by reading the creative back.

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";
const COMPANION = "a8c894bee8a29e19de28c7af0b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";
const ADSET = "120200999888";
const NAME = `AdPilot [apx:${HASH}]`;
const SQ_SHA = "b".repeat(64);
const VT_SHA = "c".repeat(64);

const base = {
  cta: "Apply now",
  headline: "Cut your card fees",
  link: "https://aps.business/eftpos",
  message: "Australian merchants are switching.",
  page_id: "101949619136828",
  target_entity_id: ADSET,
  lead_gen_form_id: "1034988492638399",
};
const square = { ...base, asset_sha256: SQ_SHA };
const vertical = { ...base, asset_sha256: VT_SHA };

function deps(over: Partial<MetaPublisherDeps> = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const uploaded: string[] = [];
  const d: MetaPublisherDeps = {
    accountId: "act_2218833115522041",
    post: async (path, body) => {
      calls.push({ path, body });
      if (path.includes("/adimages")) {
        // createAd posts base64, so decode before identifying which rendering this is. A double that
        // matched on the raw string silently mapped BOTH uploads to the square.
        const b = String((body as { bytes?: unknown }).bytes ?? "");
        const plain = Buffer.from(b, "base64").toString("utf8");
        uploaded.push(plain);
        return { images: { bytes: { hash: plain.includes("VERT") ? "IMG_VT" : "IMG_SQ" } } };
      }
      if (path.includes("/adcreatives")) return { id: "creative_1" };
      if (path.includes("/ads")) return { id: "ad_new" };
      return {};
    },
    // The page's linked Instagram account. Required from 2026-08-28: naming instagram_positions in a
    // rule makes the ad target Instagram explicitly, and Meta then demands an identity (subcode
    // 1772103). Production has one — @aps_au on the approved page.
    get: async (p: string) => (String(p).includes("instagram") ? { instagram_business_account: { id: "17841458747656615" } } : { data: [] }),
    readComposition: async (h: string) => (h === COMPANION ? vertical : square),
    readAsset: async (sha: string) => ({
      bytes: Buffer.from(sha === VT_SHA ? "VERT-bytes" : "SQ-bytes"),
      mime: "image/png",
    }),
    ...over,
  };
  return { calls, uploaded, d, publisher: createMetaPublisher(d) };
}

const creativeOf = (calls: Array<{ path: string; body: Record<string, unknown> }>) =>
  calls.find((c) => c.path.includes("/adcreatives"))!.body as Record<string, any>;

// ---------- with a companion: ONE creative, BOTH images ----------

test("both images are uploaded, and exactly one creative and one ad are created", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  assert.equal(calls.filter((c) => c.path.includes("/adimages")).length, 2, "two renderings, two uploads");
  assert.equal(calls.filter((c) => c.path.includes("/adcreatives")).length, 1, "ONE creative carries both");
  assert.equal(calls.filter((c) => c.path.endsWith("/ads")).length, 1, "ONE ad — never one per format");
});

test("the creative carries asset_feed_spec with both image hashes, each labelled", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  const afs = creativeOf(calls).asset_feed_spec;
  assert.ok(afs, "no asset_feed_spec means no placement customization");
  assert.equal(afs.images.length, 2);
  const labels = afs.images.map((i: any) => i.adlabels[0].name);
  assert.equal(new Set(labels).size, 2, "each image needs its OWN label or a rule cannot address it");
  const hashes = afs.images.map((i: any) => i.hash);
  assert.ok(hashes.includes("IMG_SQ") && hashes.includes("IMG_VT"), `got ${JSON.stringify(hashes)}`);
});

test("there is a DEFAULT rule with an EMPTY customization_spec, and it carries the SQUARE", async () => {
  // subcode 1885923: Meta rejects the creative outright without this rule.
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  const afs = creativeOf(calls).asset_feed_spec;
  const rules = afs.asset_customization_rules;
  const def = rules.filter((r: any) => Object.keys(r.customization_spec || {}).length === 0);
  assert.equal(def.length, 1, "exactly one default rule — Meta requires one and only one catch-all");
  const sqLabel = afs.images.find((i: any) => i.hash === "IMG_SQ").adlabels[0].name;
  assert.equal(def[0].image_label.name, sqLabel, "the square is the rendering the approval card previewed");
});

test("the vertical rule targets story placements", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  const afs = creativeOf(calls).asset_feed_spec;
  const vtLabel = afs.images.find((i: any) => i.hash === "IMG_VT").adlabels[0].name;
  const rule = afs.asset_customization_rules.find((r: any) => r.image_label?.name === vtLabel);
  assert.ok(rule, "the vertical must be addressed by a rule or it will never be shown");
  const spec = rule.customization_spec;
  assert.ok(Array.isArray(spec.facebook_positions) && spec.facebook_positions.includes("story"));
  assert.ok(Array.isArray(spec.instagram_positions) && spec.instagram_positions.includes("story"));
});

test("ONLY the image varies — no rule may carry a body/title/link/CTA label", async () => {
  // subcode 2446501. This is the mistake that cost two probe attempts: customizing several asset
  // types at once switches Meta into location-localization mode.
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  const afs = creativeOf(calls).asset_feed_spec;
  for (const r of afs.asset_customization_rules) {
    for (const forbidden of ["body_label", "title_label", "link_url_label", "call_to_action_label", "description_label"]) {
      assert.equal(r[forbidden], undefined, `${forbidden} in a rule triggers Meta subcode 2446501`);
    }
  }
});

test("the copy assets are UNLABELLED singletons", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  const afs = creativeOf(calls).asset_feed_spec;
  assert.equal(afs.bodies.length, 1);
  assert.equal(afs.titles.length, 1);
  assert.equal(afs.link_urls.length, 1);
  for (const group of [afs.bodies, afs.titles, afs.link_urls]) {
    assert.equal(group[0].adlabels, undefined, "a labelled copy asset invites the multi-dimension mode");
  }
});

test("the approved words and destination are what actually ship", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  const afs = creativeOf(calls).asset_feed_spec;
  assert.equal(afs.bodies[0].text, square.message);
  assert.equal(afs.titles[0].text, square.headline);
  assert.equal(afs.link_urls[0].website_url, square.link);
});

test("THE LEAD FORM SURVIVES — it is the whole point of a lead ad", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  const body = creativeOf(calls);
  assert.ok(JSON.stringify(body).includes(square.lead_gen_form_id), "the instant form must be in the creative");
  const afs = body.asset_feed_spec;
  assert.deepEqual(afs.call_to_action_types, ["SIGN_UP"]);
  assert.equal(afs.call_to_actions[0].value.lead_gen_form_id, square.lead_gen_form_id);
});

test("object_story_spec carries the PAGE ONLY — link_data would conflict with the feed spec", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  const body = creativeOf(calls);
  const oss: Record<string, unknown> = JSON.parse(JSON.stringify(body.object_story_spec));
  // link_data is checked BEFORE deepEqual on purpose: assert/strict's deepEqual is typed
  // `asserts actual is T`, so it narrows `oss` to exactly `{ page_id: string }` and the compiler then
  // rejects any further property access. Order, not a cast.
  assert.equal(oss.link_data, undefined, "link_data would compete with the feed spec for the same slots");
  assert.deepEqual(oss, { page_id: square.page_id });
});

test("ad_formats is SINGLE_IMAGE", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  assert.deepEqual(creativeOf(calls).asset_feed_spec.ad_formats, ["SINGLE_IMAGE"]);
});

test("the ad is STILL created paused, and the name is still passed through exactly", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  const ad = calls.find((c) => c.path.endsWith("/ads"))!.body;
  assert.equal(ad.status, "PAUSED");
  assert.equal(ad.name, NAME);
});

// ---------- without a companion: unchanged single-image behaviour ----------

test("NO companion -> the original single-image creative, no asset_feed_spec", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const body = creativeOf(calls);
  assert.equal(body.asset_feed_spec, undefined, "a lone approval must not gain a feed spec");
  assert.ok(body.object_story_spec.link_data, "it keeps the proven single-image shape");
  assert.equal(calls.filter((c) => c.path.includes("/adimages")).length, 1);
});

test("an empty or blank companion is treated as absent, not as an error", async () => {
  for (const c of ["", "   ", undefined]) {
    const { calls, publisher } = deps();
    await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: c as any });
    assert.equal(creativeOf(calls).asset_feed_spec, undefined);
  }
});

// ---------- a companion that cannot be TRUSTED is refused, never silently dropped ----------

async function refuses(over: Partial<MetaPublisherDeps>, match: RegExp) {
  const { calls, publisher } = deps(over);
  await assert.rejects(
    () => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION }),
    match
  );
  assert.equal(calls.filter((c) => c.path.endsWith("/ads")).length, 0, "no ad may be created on a refusal");
}

test("a companion with NO approved composition refuses", async () => {
  await refuses(
    { readComposition: async (h: string) => (h === COMPANION ? null : square) as any },
    /companion/i
  );
});

test("a companion whose WORDS differ refuses — that is a different creative", async () => {
  await refuses(
    { readComposition: async (h: string) => (h === COMPANION ? { ...vertical, message: "Different words entirely." } : square) as any },
    /companion/i
  );
});

test("a companion with a different HEADLINE refuses", async () => {
  await refuses(
    { readComposition: async (h: string) => (h === COMPANION ? { ...vertical, headline: "Other headline" } : square) as any },
    /companion/i
  );
});

test("a companion with a different LINK refuses", async () => {
  await refuses(
    { readComposition: async (h: string) => (h === COMPANION ? { ...vertical, link: "https://example.com/other" } : square) as any },
    /companion/i
  );
});

test("a companion with a different LEAD FORM refuses", async () => {
  await refuses(
    { readComposition: async (h: string) => (h === COMPANION ? { ...vertical, lead_gen_form_id: "9999999999" } : square) as any },
    /companion/i
  );
});

test("a companion with a different TARGET AD SET refuses", async () => {
  await refuses(
    { readComposition: async (h: string) => (h === COMPANION ? { ...vertical, target_entity_id: "999888777" } : square) as any },
    /companion/i
  );
});

test("a companion with a different PAGE refuses", async () => {
  await refuses(
    { readComposition: async (h: string) => (h === COMPANION ? { ...vertical, page_id: "999" } : square) as any },
    /companion/i
  );
});

test("a companion with the SAME asset refuses — two identical images is not two renderings", async () => {
  await refuses(
    { readComposition: async (h: string) => (h === COMPANION ? { ...vertical, asset_sha256: SQ_SHA } : square) as any },
    /companion/i
  );
});

test("a companion whose IMAGE BYTES are missing refuses", async () => {
  await refuses(
    { readAsset: async (sha: string) => (sha === VT_SHA ? null : { bytes: Buffer.from("SQ-bytes"), mime: "image/png" }) as any },
    /companion|asset/i
  );
});

test("a companion equal to the primary hash refuses", async () => {
  const { calls, publisher } = deps();
  await assert.rejects(
    () => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: HASH }),
    /companion/i
  );
  assert.equal(calls.filter((c) => c.path.endsWith("/ads")).length, 0);
});

test("an upload that returns no hash for the companion refuses rather than shipping one image", async () => {
  await refuses(
    {
      post: async (path: string, body: Record<string, unknown>) => {
        if (path.includes("/adimages")) {
          // base64, like the real post body — matching the raw string made both uploads look square,
          // so the companion "failure" never happened and the test proved nothing.
          const plain = Buffer.from(String((body as { bytes?: unknown }).bytes ?? ""), "base64").toString("utf8");
          return plain.includes("VERT") ? {} : { images: { bytes: { hash: "IMG_SQ" } } };
        }
        if (path.includes("/adcreatives")) return { id: "creative_1" };
        if (path.includes("/ads")) return { id: "ad_new" };
        return {};
      },
    },
    /hash|companion/i
  );
});
