import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetaPublisher } from "./meta-publisher.ts";
import type { MetaPublisherDeps } from "./meta-publisher.ts";

// The video half of the only code that creates something in Meta.
//
// Same safety property as the image path and it is asserted here independently: the ad is created
// **PAUSED**, every word comes from the approved composition, the ad name is passed through
// byte-for-byte, and nothing retries. The wait for Meta's transcode is bounded and read-only; reads
// cannot spend. The transport is injected, so these tests make no network call and cost nothing.
//
// The medium is decided by the STORED ASSET'S MIME, never by a caller argument — an image approval
// can never reach /advideos and a video approval can never reach /adimages.

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";
const ADSET = "120200999888";
const NAME = `AdPilot [apx:${HASH}]`;
const SHA = "c".repeat(64);
const VIDEO_ID = "23851234567890123";
const THUMB = "https://scontent.example/preferred.jpg";

const composition = {
  asset_sha256: SHA,
  cta: "Apply now",
  headline: "Cut your card fees",
  link: "https://aps.business/eftpos",
  message: "Australian merchants are switching.",
  page_id: "101949619136828",
  target_entity_id: ADSET,
};

const refusalsProven = new Set<string>();

function deps(over: Partial<MetaPublisherDeps> = {}, statuses: string[] = ["ready"]) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let poll = 0;
  const d: MetaPublisherDeps = {
    accountId: "act_2218833115522041",
    post: async (path, body) => {
      calls.push({ path, body });
      if (path.includes("/adcreatives")) return { id: "creative_v1" };
      if (path.includes("/ads")) return { id: "ad_video_new" };
      return {};
    },
    get: async (path) => {
      calls.push({ path, body: {} });
      if (path.includes("fields=status")) {
        return { id: VIDEO_ID, status: { video_status: statuses[Math.min(poll++, statuses.length - 1)] } };
      }
      if (path.includes("/thumbnails")) {
        return { data: [{ uri: "https://scontent.example/first.jpg" }, { uri: THUMB, is_preferred: true }] };
      }
      return { data: [] };
    },
    postMultipart: async (path, parts) => {
      calls.push({ path, body: parts as Record<string, unknown> });
      return { id: VIDEO_ID };
    },
    readComposition: async () => composition,
    readAsset: async () => ({ bytes: Buffer.from("fake-mp4-bytes"), mime: "video/mp4" }),
    videoWait: { sleep: async () => {} },
    ...over,
  };
  return { calls, d, publisher: createMetaPublisher(d) };
}

const leaf = (p: string) => p.replace(/^\/act_[^/]+\//, "").replace(/^\//, "");

test("the video calls happen in exactly this order, and the outputs chain", async () => {
  const { calls, publisher } = deps({}, ["processing", "ready"]);
  const r = await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  assert.deepEqual(calls.map((c) => leaf(c.path)), [
    "advideos",
    `${VIDEO_ID}?fields=status`,
    `${VIDEO_ID}?fields=status`,
    `${VIDEO_ID}/thumbnails`,
    "adcreatives",
    "ads",
  ]);
  assert.equal(r.id, "ad_video_new");
});

test("THE VIDEO AD IS CREATED PAUSED — always", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const adCall = calls.find((c) => c.path.endsWith("/ads"))!;
  assert.equal(adCall.body.status, "PAUSED");
  assert.equal(adCall.body.name, NAME, "the ad name IS the idempotency key");
  assert.equal(adCall.body.adset_id, ADSET);
  assert.match(JSON.stringify(adCall.body.creative), /creative_v1/);
});

test("the bytes are sent as a multipart part named `source`, named from the approved address", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const up = calls.find((c) => c.path.endsWith("/advideos"))!;
  const source = up.body.source as File;
  assert.ok(source instanceof Blob, "the video must be sent as a file part, not form-encoded");
  assert.equal((source as File).name, `${SHA}.mp4`);
  assert.equal(source.type, "video/mp4");
  assert.equal(source.size, Buffer.from("fake-mp4-bytes").length);
});

test("the creative carries video_data built from the APPROVED composition and Meta's preferred thumbnail", async () => {
  const { calls, publisher } = deps();
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const body = calls.find((c) => c.path.endsWith("/adcreatives"))!.body as {
    name: string;
    object_story_spec: { page_id: string; video_data: Record<string, unknown> };
  };
  assert.equal(body.name, NAME);
  assert.equal(body.object_story_spec.page_id, composition.page_id);
  const vd = body.object_story_spec.video_data;
  assert.equal(vd.video_id, VIDEO_ID);
  assert.equal(vd.image_url, THUMB, "the is_preferred thumbnail wins");
  assert.equal(vd.message, composition.message);
  assert.equal(vd.title, composition.headline);
  assert.equal((vd.call_to_action as { type: string }).type, "LEARN_MORE");
  assert.deepEqual((vd.call_to_action as { value: unknown }).value, { link: composition.link });
});

test("with a sealed lead form the CTA is SIGN_UP carrying the form — identical to the image path", async () => {
  const withForm = { ...composition, lead_gen_form_id: "  1234567890  " };
  const { calls, publisher } = deps({ readComposition: async () => withForm });
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const vd = (calls.find((c) => c.path.endsWith("/adcreatives"))!.body as any).object_story_spec.video_data;
  assert.deepEqual(vd.call_to_action, { type: "SIGN_UP", value: { lead_gen_form_id: "1234567890" } });
});

test("with no is_preferred thumbnail the first one is used", async () => {
  const { calls, publisher } = deps({
    get: async (path) => {
      if (path.includes("fields=status")) return { status: { video_status: "ready" } };
      if (path.includes("/thumbnails")) return { data: [{ uri: "https://scontent.example/only.jpg" }] };
      return { data: [] };
    },
  });
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  const vd = (calls.find((c) => c.path.endsWith("/adcreatives"))!.body as any).object_story_spec.video_data;
  assert.equal(vd.image_url, "https://scontent.example/only.jpg");
});

// ---- refusals: every one leaves the ad uncreated ---------------------------

test("REFUSAL video_upload_failed — an upload with no video id creates nothing", async () => {
  const { calls, publisher } = deps({ postMultipart: async () => ({}) });
  await assert.rejects(
    () => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }),
    /video_upload_failed/
  );
  assert.equal(calls.filter((c) => c.path.endsWith("/ads")).length, 0);
  refusalsProven.add("video_upload_failed");
});

test("REFUSAL video_not_ready — 20 bounded checks, then nothing is created", async () => {
  const { calls, publisher } = deps({}, ["processing"]);
  await assert.rejects(
    () => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }),
    /video_not_ready/
  );
  assert.equal(calls.filter((c) => c.path.includes("fields=status")).length, 20);
  assert.equal(calls.filter((c) => c.path.endsWith("/adcreatives")).length, 0);
  assert.equal(calls.filter((c) => c.path.endsWith("/ads")).length, 0);
  refusalsProven.add("video_not_ready");
});

test("REFUSAL video_upload_failed — a publisher with no multipart transport uploads nothing", async () => {
  const { calls, d } = deps();
  const noMultipart = { ...d };
  delete (noMultipart as { postMultipart?: unknown }).postMultipart;
  const { createMetaPublisher: make } = await import("./meta-publisher.ts");
  await assert.rejects(
    () => make(noMultipart).createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }),
    /video_upload_failed/
  );
  assert.equal(calls.length, 0, "a transport-less publisher must not call Meta at all");
});

test("a thumbnail list that lags behind ready is re-read before refusing", async () => {
  let n = 0;
  const { calls, publisher } = deps({
    get: async (path) => {
      calls.push({ path, body: {} });
      if (path.includes("fields=status")) return { status: { video_status: "ready" } };
      return n++ < 2 ? { data: [] } : { data: [{ uri: THUMB, is_preferred: true }] };
    },
  });
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  assert.equal(calls.filter((c) => c.path.includes("/thumbnails")).length, 3);
  const vd = (calls.find((c) => c.path.endsWith("/adcreatives"))!.body as any).object_story_spec.video_data;
  assert.equal(vd.image_url, THUMB);
});

test("REFUSAL video_thumbnail_missing — no usable poster frame creates nothing", async () => {
  const { calls, publisher } = deps({
    get: async (path) => {
      calls.push({ path, body: {} });
      return path.includes("fields=status") ? { status: { video_status: "ready" } } : { data: [] };
    },
  });
  await assert.rejects(
    () => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }),
    /video_thumbnail_missing/
  );
  assert.equal(calls.filter((c) => c.path.includes("/thumbnails")).length, 5, "bounded re-reads, then refuse");
  assert.equal(calls.filter((c) => c.path.endsWith("/adcreatives")).length, 0);
  refusalsProven.add("video_thumbnail_missing");
});

test("REFUSAL video_companion_unsupported — nothing is uploaded and nothing is consumed", async () => {
  const { calls, publisher } = deps();
  await assert.rejects(
    () => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash: "d".repeat(64) }),
    /video_companion_unsupported/
  );
  assert.equal(calls.length, 0, "a refused companion video must not upload anything");
  refusalsProven.add("video_companion_unsupported");
});

test("REFUSAL asset_mime_unsupported — an asset that is neither image nor video creates nothing", async () => {
  for (const mime of ["application/pdf", "", "text/html"]) {
    const { calls, publisher } = deps({ readAsset: async () => ({ bytes: Buffer.from("x"), mime }) });
    await assert.rejects(
      () => publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH }),
      /asset_mime_unsupported/,
      mime
    );
    assert.equal(calls.length, 0, `${mime}: no Meta call may happen`);
  }
  refusalsProven.add("asset_mime_unsupported");
});

// ---- the two media can never cross over ------------------------------------

test("a VIDEO asset can never reach /adimages, whatever the caller asks for", async () => {
  // Mutation-style: every shape of call the publisher accepts, against a video asset. If any of them
  // ever reached the image edge, the ad would be built from bytes Meta cannot render.
  for (const companionHash of [undefined, "d".repeat(64)]) {
    const { calls, publisher } = deps();
    await publisher
      .createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH, companionHash })
      .catch(() => {});
    assert.equal(
      calls.filter((c) => c.path.includes("/adimages")).length,
      0,
      "a video approval must never touch the image upload edge"
    );
  }
});

test("an IMAGE asset never reaches /advideos — the image path is untouched", async () => {
  const { calls, publisher } = deps({
    readAsset: async () => ({ bytes: Buffer.from("fake-png"), mime: "image/png" }),
    post: async (path, body) => {
      calls.push({ path, body });
      if (path.includes("/adimages")) return { images: { bytes: { hash: "IMGHASH123" } } };
      if (path.includes("/adcreatives")) return { id: "creative_1" };
      return { id: "ad_new" };
    },
  });
  await publisher.createAd({ adsetId: ADSET, name: NAME, approvalHash: HASH });
  assert.deepEqual(calls.map((c) => leaf(c.path)), ["adimages", "adcreatives", "ads"]);
});

test("video publish refusals proven", () => {
  const expected = [
    "video_upload_failed",
    "video_not_ready",
    "video_thumbnail_missing",
    "video_companion_unsupported",
    "asset_mime_unsupported",
  ];
  console.log(`video publish refusals proven: ${expected.filter((r) => refusalsProven.has(r)).length}/5`);
  for (const r of expected) assert.ok(refusalsProven.has(r), `refusal not proven: ${r}`);
});
