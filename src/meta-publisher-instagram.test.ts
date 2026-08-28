import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetaPublisher } from "./meta-publisher.ts";
import type { MetaPublisherDeps } from "./meta-publisher.ts";

// A two-format creative names `instagram_positions` in its story rule, so the ad EXPLICITLY targets
// Instagram — and Meta then demands an Instagram identity. Proven against the live account:
//   code 100 / subcode 1772103 — "Instagram account is missing.
//   Select an Instagram account or Facebook Page to represent your business on Instagram."
// The single-image path never names Instagram, so Meta fills the identity in silently; the working
// creative in the trial ad set carries instagram_user_id "17841458747656615" (@aps_au) unasked.
//
// So the identity is resolved from the PAGE the approval already names — never hardcoded, never from
// a caller argument — and only on the two-format path, so the proven single-image body is untouched.

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";
const COMPANION = "a8c894bee8a29e19de28c7af9b779a340ec97ac03a47cda80708db8c3dc66e76";
const ADSET = "120200999888";
const NAME = `AdPilot [apx:${HASH}]`;
const IG = "17841458747656615";

const base = {
  cta: "Apply now", headline: "H", link: "https://aps.business/eftpos", message: "M",
  page_id: "101949619136828", target_entity_id: ADSET, lead_gen_form_id: "1034988492638399",
};
const square = { ...base, asset_sha256: "b".repeat(64) };
const vertical = { ...base, asset_sha256: "c".repeat(64) };

function deps(over: Partial<MetaPublisherDeps> = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const gets: string[] = [];
  const d: MetaPublisherDeps = {
    accountId: "act_2218833115522041",
    post: async (path, body) => {
      calls.push({ path, body });
      if (path.includes("/adimages")) {
        const plain = Buffer.from(String((body as { bytes?: unknown }).bytes ?? ""), "base64").toString("utf8");
        return { images: { bytes: { hash: plain.includes("VERT") ? "IMG_VT" : "IMG_SQ" } } };
      }
      if (path.includes("/adcreatives")) return { id: "creative_1" };
      if (path.endsWith("/ads")) return { id: "ad_new" };
      return {};
    },
    get: async (p: string) => {
      gets.push(p);
      if (p.includes("instagram")) return { instagram_business_account: { id: IG } };
      return { data: [] };
    },
    readComposition: async (h: string) => (h === COMPANION ? vertical : square),
    readAsset: async (sha: string) => ({ bytes: Buffer.from(sha === "c".repeat(64) ? "VERT-bytes" : "SQ-bytes"), mime: "image/png" }),
    ...over,
  };
  return { calls, gets, d, publisher: createMetaPublisher(d) };
}
const creativeOf = (calls: Array<{ path: string; body: Record<string, unknown> }>) =>
  calls.find((c) => c.path.includes("/adcreatives"))!.body as Record<string, any>;

test("a two-format creative carries the Instagram identity", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  assert.equal(creativeOf(calls).instagram_user_id, IG, "without this /ads refuses with subcode 1772103");
});

test("the identity is read from the APPROVED page, not passed in or hardcoded", async () => {
  const { gets, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  const asked = gets.find((g) => g.includes(square.page_id));
  assert.ok(asked, `the page was never queried; gets were ${JSON.stringify(gets)}`);
  assert.match(asked, /instagram/, "it must ask for the page's linked Instagram account");
});

test("a page with NO linked Instagram account REFUSES rather than shipping a doomed ad", async () => {
  const { calls, publisher } = deps({ get: async () => ({}) });
  await assert.rejects(
    () => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION }),
    /instagram/i
  );
  assert.equal(calls.filter((c) => c.path.endsWith("/ads")).length, 0, "no ad may be attempted");
});

test("a page lookup that THROWS refuses too — it does not guess an identity", async () => {
  const { calls, publisher } = deps({ get: async () => { throw new Error("graph 500"); } });
  await assert.rejects(
    () => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION }),
    /instagram/i
  );
  assert.equal(calls.filter((c) => c.path.endsWith("/ads")).length, 0);
});

test("the SINGLE-image path is untouched — no lookup, no new field", async () => {
  // That body is proven in production twice. It must not change.
  const { calls, gets, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  assert.equal(creativeOf(calls).instagram_user_id, undefined, "the proven single-image body must not gain a field");
  assert.equal(gets.filter((g) => g.includes("instagram")).length, 0, "and must not cost an extra read");
});

test("a connected_instagram_account is accepted when instagram_business_account is absent", async () => {
  const { calls, publisher } = deps({
    get: async () => ({ connected_instagram_account: { id: IG } }),
  });
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION });
  assert.equal(creativeOf(calls).instagram_user_id, IG);
});

test("a malformed instagram id is refused, not sent", async () => {
  for (const bad of [{ instagram_business_account: { id: "" } }, { instagram_business_account: {} }, { instagram_business_account: null }]) {
    const { publisher } = deps({ get: async () => bad as any });
    await assert.rejects(
      () => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: COMPANION }),
      /instagram/i
    );
  }
});
