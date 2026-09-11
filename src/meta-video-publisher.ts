/**
 * The VIDEO half of the one path that creates something in Meta.
 *
 * It exists as its own module for a structural reason: a video cannot be used until Meta has finished
 * processing it, so publishing one requires WAITING, and meta-publisher.ts is asserted to contain no
 * loop at all. The wait is quarantined in video-ready.ts and this module simply calls it once.
 *
 * Everything that made the image path safe is preserved, unchanged and not re-decided here:
 *   * the ad is created **PAUSED** — there is no path to a delivering ad;
 *   * every word comes from the APPROVED composition, never from caller arguments;
 *   * the ad `name` is passed through byte-for-byte, because it IS the idempotency key;
 *   * nothing retries — a failure throws, executePublish leaves the approval unconsumed, and the next
 *     run resolves the outcome through the ad name's natural key;
 *   * search-before-create, verify-after-create and consume stay where they were, around this call,
 *     in executePublish. They are deliberately NOT duplicated here.
 *
 * Only the AD can spend. Uploading a video and creating a creative are harmless to repeat: an orphaned
 * video or creative delivers nothing and costs nothing.
 *
 * Refusal codes raised here: video_upload_failed, video_not_ready (from video-ready), and
 * video_thumbnail_missing.
 */
import { callToActionFor, type Composition } from "./meta-publisher.js";
import { waitUntilReady, type WaitOptions } from "./video-ready.js";

export interface VideoGraph {
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
  get(path: string): Promise<Record<string, unknown>>;
  postMultipart(path: string, parts: Record<string, string | number | boolean | Blob | undefined>): Promise<unknown>;
}

export interface VideoPublishContext {
  accountId: string;
  adsetId: string;
  // The idempotency key. Passed through untouched.
  name: string;
  comp: Composition;
  asset: { bytes: Buffer; mime: string };
  graph: VideoGraph;
  // Injected only so tests exercise the real bound instantly.
  wait?: WaitOptions;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

// Meta's own preferred thumbnail for the uploaded video. Ruled (2026-09-11): no app-side thumbnail,
// no migration, no fingerprint change — the poster frame is Meta's, chosen the way Meta's own
// composer chooses it. `is_preferred` when Meta marks one, else the first it returns.
function preferredThumbnail(res: unknown): string | null {
  const data = (res as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const rows = data as Array<{ uri?: unknown; is_preferred?: unknown }>;
  const chosen = rows.find((t) => t && t.is_preferred === true) ?? rows[0];
  return nonEmpty(chosen?.uri) ? chosen.uri.trim() : null;
}

export async function publishVideo(ctx: VideoPublishContext): Promise<{ id: string }> {
  const { accountId, adsetId, name, comp, asset, graph } = ctx;

  // 1. The video bytes, sent as a real file part. /advideos takes the file under the part name
  //    `source`; it cannot be form-encoded the way the image path base64s into /adimages.
  //    The filename is derived from the approved content address, so it can only ever describe the
  //    bytes a human signed.
  const mime = nonEmpty(asset.mime) ? asset.mime.trim() : "video/mp4";
  const file = new File([new Uint8Array(asset.bytes)], `${comp.asset_sha256}.mp4`, { type: mime });
  const uploaded = await graph.postMultipart(`/${accountId}/advideos`, { source: file });
  const videoId = (uploaded as { id?: unknown } | null)?.id;
  if (!nonEmpty(videoId)) {
    throw new Error("video_upload_failed: the video upload returned no video id — refusing to build a creative");
  }
  const vid = videoId.trim();

  // 2. Wait for Meta to finish processing. Bounded, read-only, and refuses rather than pushing a
  //    half-transcoded video into a creative. The loop lives in video-ready.ts.
  await waitUntilReady(graph, vid, ctx.wait ?? {});

  // 3. Meta's preferred poster frame. A video creative with no image_url is rejected, so an absent
  //    thumbnail refuses here with a readable reason instead of there with "Invalid parameter".
  const thumbs = await graph.get(`/${vid}/thumbnails`);
  const imageUrl = preferredThumbnail(thumbs);
  if (!imageUrl) {
    throw new Error("video_thumbnail_missing: Meta returned no usable thumbnail for the video — refusing to build a creative");
  }

  // 4. The creative. Safe to repeat; a creative with no ad delivers nothing. The CTA rule is the
  //    image path's, imported rather than restated: a leads-objective ad set REFUSES a form-less
  //    creative, and the form a human sealed decides what data is collected from people.
  const created = await graph.post(`/${accountId}/adcreatives`, {
    name,
    object_story_spec: {
      page_id: comp.page_id,
      video_data: {
        video_id: vid,
        image_url: imageUrl,
        message: comp.message,
        title: comp.headline,
        call_to_action: callToActionFor(comp),
      },
    },
  });
  const creativeId = (created as { id?: unknown } | null)?.id;
  if (!nonEmpty(creativeId)) {
    throw new Error("meta-video-publisher: creative returned no creative id — refusing to create an ad");
  }

  // 5. THE AD — the one call that could ever spend, and it is created PAUSED, exactly as on the
  //    image path. Filed on the ACCOUNT edge; the destination comes only from the approval.
  const ad = await graph.post(`/${accountId}/ads`, {
    name,
    adset_id: adsetId,
    creative: { creative_id: creativeId.trim() },
    status: "PAUSED",
  });
  const adId = (ad as { id?: unknown } | null)?.id;
  if (!nonEmpty(adId)) {
    throw new Error("meta-video-publisher: ad creation returned no id — outcome unknown");
  }
  return { id: adId.trim() };
}
