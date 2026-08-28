import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetaPublisher } from "./meta-publisher.ts";
import type { MetaPublisherDeps } from "./meta-publisher.ts";

// The ONLY code in AdPilot that creates something in Meta.
//
// THE CENTRAL SAFETY PROPERTY: every ad is created **PAUSED**. There is no code path to ACTIVE. A
// paused ad cannot deliver and therefore cannot spend, which makes the one non-idempotent write in the
// system also the one that costs nothing until a human deliberately switches it on. The approval gate
// authorises the ad's EXISTENCE; a human still authorises its SPEND.
//
// Note the asymmetry between the three Meta calls. Uploading an image and creating an adcreative are
// harmless to repeat — an orphaned image or creative delivers nothing and costs nothing. Only the AD
// can spend. So idempotency effort belongs on the ad create alone, which is exactly where
// executePublish puts it (per-approval lock + search-before-create + verify-after-create).
//
// Nothing here retries. Nothing here decides. The transport is injected, so these tests make no network
// call and cost nothing.

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";
const ADSET = "120200999888";
const NAME = `AdPilot [apx:${HASH}]`;
const SHA = "b".repeat(64);

const composition = {
  asset_sha256: SHA,
  cta: "Apply now",
  headline: "Cut your card fees",
  link: "https://aps.business/eftpos",
  message: "Australian merchants are switching.",
  page_id: "101949619136828",
  target_entity_id: ADSET,
};

function deps(over: Partial<MetaPublisherDeps> = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const d: MetaPublisherDeps = {
    accountId: "act_2218833115522041",
    post: async (path, body) => {
      calls.push({ path, body });
      if (path.includes("/adimages")) return { images: { bytes: { hash: "IMGHASH123" } } };
      if (path.includes("/adcreatives")) return { id: "creative_1" };
      if (path.includes("/ads")) return { id: "ad_new" };
      return {};
    },
    get: async () => ({ data: [] }),
    readComposition: async () => composition,
    readAsset: async () => ({ bytes: Buffer.from("fake-png-bytes"), mime: "image/png" }),
    ...over,
  };
  return { calls, d, publisher: createMetaPublisher(d) };
}

test("THE AD IS CREATED PAUSED — always", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const adCall = calls.find((c) => c.path.endsWith("/ads"));
  assert.ok(adCall, "an ad must be created");
  assert.equal(adCall.body.status, "PAUSED", "a created ad must never be able to deliver before a human says so");
});

test("there is NO code path that creates an ACTIVE ad", async () => {
  // Structural, not behavioural: the safety property must not depend on a caller passing the right
  // option. Nothing in the module may emit ACTIVE.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./meta-publisher.ts", import.meta.url), "utf8")
  );
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /["']ACTIVE["']/, "the module must not contain the string ACTIVE in code");
});

test("the ad name is passed through EXACTLY — never altered, prefixed or truncated", async () => {
  // The name IS the idempotency key. Any mutation of it destroys search-before-create.
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const adCall = calls.find((c) => c.path.endsWith("/ads"))!;
  assert.equal(adCall.body.name, NAME);
});

test("the ad lands in the ad set it was told to, and carries the created creative", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const adCall = calls.find((c) => c.path.endsWith("/ads"))!;
  assert.equal(adCall.body.adset_id, ADSET);
  assert.match(JSON.stringify(adCall.body.creative), /creative_1/, "the ad must reference the creative just made");
});

test("the three calls happen in order, and the outputs chain", async () => {
  const { calls, publisher } = deps();
  const r = await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  assert.deepEqual(calls.map((c) => c.path.replace(/^.*\//, "")), ["adimages", "adcreatives", "ads"]);
  const creativeCall = calls[1];
  assert.match(JSON.stringify(creativeCall.body), /IMGHASH123/, "the creative must use the uploaded image hash");
  assert.equal(r.id, "ad_new");
});

test("the creative is built from the APPROVED composition, not from arguments", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const body = JSON.stringify(calls[1].body);
  for (const v of [composition.headline, composition.message, composition.link, composition.page_id]) {
    assert.match(body, new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `composition value missing: ${v}`);
  }
});

test("a missing composition refuses BEFORE any Meta call", async () => {
  const { calls, publisher } = deps({ readComposition: async () => null });
  await assert.rejects(() => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }), /composition/i);
  assert.equal(calls.length, 0, "nothing may be created from an approval we cannot read");
});

test("a composition missing any required field refuses BEFORE any Meta call", async () => {
  for (const k of ["asset_sha256", "cta", "headline", "link", "message", "page_id"] as const) {
    const partial = { ...composition, [k]: "" };
    const { calls, publisher } = deps({ readComposition: async () => partial });
    await assert.rejects(() => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }), /composition/i, k);
    assert.equal(calls.length, 0, `${k}: no Meta call may happen`);
  }
});

test("a missing image asset refuses BEFORE any Meta call", async () => {
  const { calls, publisher } = deps({ readAsset: async () => null });
  await assert.rejects(() => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }), /asset|image/i);
  assert.equal(calls.length, 0);
});

test("an unusable name or ad set refuses BEFORE any Meta call", async () => {
  for (const [n, a] of [["", ADSET], ["   ", ADSET], [NAME, ""], [NAME, "   "]]) {
    const { calls, publisher } = deps();
    await assert.rejects(() => publisher.createAd({ adsetId: a, name: n, approvalHash: HASH }));
    assert.equal(calls.length, 0);
  }
});

test("an upload failure stops the chain — no creative, no ad", async () => {
  const { calls, publisher } = deps({
    post: async (path) => { if (path.includes("/adimages")) throw new Error("meta 500"); return { id: "x" }; },
  });
  await assert.rejects(() => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }));
  assert.equal(calls.length, 0, "the fake records nothing because the first call threw");
});

test("an image upload returning no hash refuses rather than creating a blank creative", async () => {
  const { publisher } = deps({
    post: async (path) => (path.includes("/adimages") ? { images: {} } : { id: "x" }),
  });
  await assert.rejects(() => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }), /image hash/i);
});

test("a creative returning no id refuses rather than creating an ad with no creative", async () => {
  const { publisher } = deps({
    post: async (path) => {
      if (path.includes("/adimages")) return { images: { bytes: { hash: "IMGHASH123" } } };
      if (path.includes("/adcreatives")) return {};
      return { id: "ad_new" };
    },
  });
  await assert.rejects(() => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }), /creative id/i);
});

test("NOTHING is retried: the write call sites are pinned BY EDGE, and no retry construct exists", async () => {
  // An earlier version banned every `for`/`while`, which flagged the field-validation loop and the loop
  // over Meta's image-response keys — neither is a retry. Banning all loops is not the property; "a
  // write is never issued more than once" is.
  //
  // Updated 2026-08-28: a FOURTH write site was added — the companion rendering's image upload, so one
  // ad can carry both the square and the vertical. A bare count would have had to be bumped from 3 to
  // 4, which is exactly how this test would rot into a rubber stamp. So it now pins the sites BY EDGE
  // instead. What actually matters is unchanged and is now stated directly: there is exactly ONE site
  // that can create an AD, and exactly one that can create a creative. Image uploads are harmless to
  // repeat (an orphan image delivers nothing), which is why two of them is not a safety change.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./meta-publisher.ts", import.meta.url), "utf8")
  );
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  const sites = code.match(/deps\.post\(\s*`[^`]*`/g) || [];
  const adSites = sites.filter((s) => /\/ads\b/.test(s) || s.includes("/ads`"));
  const creativeSites = sites.filter((s) => s.includes("/adcreatives"));
  const imageSites = sites.filter((s) => s.includes("/adimages"));

  assert.equal(adSites.length, 1, `exactly ONE ad-create site is the whole safety property; found ${adSites.length}`);
  assert.equal(creativeSites.length, 1, `expected one adcreatives site; found ${creativeSites.length}`);
  assert.equal(imageSites.length, 2, `expected two adimages sites (primary + companion); found ${imageSites.length}`);
  assert.equal(sites.length, adSites.length + creativeSites.length + imageSites.length,
    "an unrecognised write edge appeared — every deps.post site must be accounted for here");
  assert.doesNotMatch(code, /\bretry|\bretries|\battempt\b|\battempts\b|backoff/i, "a retry here could create a second live ad");
});

test("BEHAVIOURAL: a failing ad create is attempted exactly ONCE", async () => {
  // The structural test above cannot see a caller-driven retry loop; this can.
  const paths: string[] = [];
  const { publisher } = deps({
    post: async (path) => {
      paths.push(path);
      if (path.includes("/adimages")) return { images: { bytes: { hash: "IMGHASH123" } } };
      if (path.includes("/adcreatives")) return { id: "creative_1" };
      throw new Error("meta 500 on ad create");
    },
  });
  await assert.rejects(() => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }));
  const adAttempts = paths.filter((p) => p.endsWith("/ads")).length;
  assert.equal(adAttempts, 1, "the ad create must be attempted once and never repeated");
});

test("searchAdsInAdset reads the ad set's ads with the fields the plan needs", async () => {
  const seen: string[] = [];
  const { publisher } = deps({
    get: async (path) => { seen.push(path); return { data: [{ id: "a1", name: NAME, adset_id: ADSET }] }; },
  });
  const rows = await publisher.searchAdsInAdset({ adsetId: ADSET, adName: NAME });
  assert.match(seen[0], new RegExp(`${ADSET}/ads`));
  assert.match(seen[0], /name/);
  assert.deepEqual(rows, [{ id: "a1", name: NAME, adset_id: ADSET }]);
});

test("search returns a plain array; a malformed answer throws rather than looking empty", async () => {
  // publish-plan treats a non-array as unreadable, but an object with no `data` must not silently
  // become [] here either — that would read as "nothing there" and license a create.
  for (const bad of [{}, { data: null }, { data: "nope" }, null]) {
    const { publisher } = deps({ get: async () => bad as Record<string, unknown> });
    await assert.rejects(() => publisher.searchAdsInAdset({ adsetId: ADSET, adName: NAME }), /ads|readable/i, JSON.stringify(bad));
  }
});

// ---- lead-form compositions (leads campaigns refuse form-less creatives; proven live 2026-08-12) ----

test("a composition WITH lead_gen_form_id builds a form-carrying CTA (type SIGN_UP, no link in value)", async () => {
  const { calls, publisher } = deps({ readComposition: async () => ({ ...composition, lead_gen_form_id: "897334729691676" }) });
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const creative = calls.find((c) => c.path.endsWith("/adcreatives"))!;
  const cta = (creative.body as any).object_story_spec.link_data.call_to_action;
  assert.deepEqual(cta, { type: "SIGN_UP", value: { lead_gen_form_id: "897334729691676" } });
});

test("a composition WITHOUT a form keeps the link CTA exactly as before (non-leads campaigns)", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const cta = (calls.find((c) => c.path.endsWith("/adcreatives"))!.body as any).object_story_spec.link_data.call_to_action;
  assert.deepEqual(cta, { type: "LEARN_MORE", value: { link: composition.link } });
});

test("a blank form id is treated as ABSENT, never sent as an empty form", async () => {
  const { calls, publisher } = deps({ readComposition: async () => ({ ...composition, lead_gen_form_id: "  " }) });
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const cta = (calls.find((c) => c.path.endsWith("/adcreatives"))!.body as any).object_story_spec.link_data.call_to_action;
  assert.deepEqual(cta, { type: "LEARN_MORE", value: { link: composition.link } });
});
