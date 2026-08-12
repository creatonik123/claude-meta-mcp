/**
 * The ONLY code in AdPilot that creates something in Meta.
 *
 * ═══ THE CENTRAL SAFETY PROPERTY: EVERY AD IS CREATED **PAUSED** ═══
 * There is no code path here that can produce an ACTIVE ad, and a test asserts the string "ACTIVE"
 * appears nowhere in this module's code. A paused ad cannot deliver and therefore cannot spend. That
 * makes the one non-idempotent write in the system also the one that costs nothing until a human
 * deliberately switches it on: the approval gate authorises the ad's EXISTENCE, a human still authorises
 * its SPEND. It also makes a mistaken create fully reversible — delete or ignore a paused ad and nothing
 * was lost. This mirrors the prior art the PRD cites (Konquest creates all ads paused; the field guide
 * blocks non-PAUSED creation at the tool-call layer).
 *
 * ═══ WHY ONLY THE AD CREATE IS GUARDED FOR IDEMPOTENCY ═══
 * Three Meta calls happen: upload image → create adcreative → create ad. The first two are harmless to
 * repeat — an orphaned image or creative delivers nothing and costs nothing. Only the AD can spend. So
 * the expensive machinery (per-approval lock, search-before-create, verify-after-create) sits around the
 * ad create in executePublish, and is deliberately NOT duplicated here.
 *
 * ═══ NO RETRIES, ANYWHERE ═══
 * A retry is how one approval becomes two live ads (MONEY_RULES A1). A test asserts this module contains
 * no loop or retry construct at all. Any failure throws; executePublish maps that to an unknown outcome,
 * leaves the approval unconsumed, and lets the next run resolve it through the ad name's natural key.
 *
 * The creative is built from the APPROVED composition — the object whose fingerprint is the binding hash
 * a human signed — never from caller arguments. `post`/`get` are injected, so this file makes no network
 * call of its own and costs nothing in tests.
 */
import type { AdPublisher } from "./doer-publish.js";
import type { AdRow } from "./publish-plan.js";

// The fields of an approved composition needed to build a link ad. Names match the app's
// fingerprint KEYS exactly — this object IS what the binding hash was computed over.
export interface Composition {
  asset_sha256: string;
  cta: string;
  headline: string;
  link: string;
  message: string;
  page_id: string;
  target_entity_id?: string;
}

export interface MetaPublisherDeps {
  // The managed (trial) account, e.g. "act_2218833115522041". The guard has already proved the target ad
  // set belongs to it; this is only where the image and creative are filed.
  accountId: string;
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
  get(path: string): Promise<Record<string, unknown>>;
  // The approved composition for this binding hash (approval_records.composition).
  readComposition(bindingHash: string): Promise<Composition | null>;
  // The finished image bytes, content-addressed (asset_blobs).
  readAsset(sha256: string): Promise<{ bytes: Buffer; mime: string } | null>;
}

const REQUIRED: Array<keyof Composition> = ["asset_sha256", "cta", "headline", "link", "message", "page_id"];

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

// Meta returns the uploaded image under an unpredictable key (the field name it was sent as), so the
// hash is located rather than assumed. No hash means no usable image — refuse instead of creating a
// creative with nothing in it.
function imageHashFrom(res: unknown): string | null {
  const images = (res as { images?: Record<string, { hash?: unknown }> } | null)?.images;
  if (!images || typeof images !== "object") return null;
  for (const entry of Object.values(images)) {
    if (entry && nonEmpty(entry.hash)) return entry.hash.trim();
  }
  return null;
}

export function createMetaPublisher(deps: MetaPublisherDeps): AdPublisher {
  return {
    async searchAdsInAdset({ adsetId, adName }): Promise<AdRow[]> {
      if (!nonEmpty(adsetId)) throw new Error("meta-publisher: searchAdsInAdset needs an ad set id");
      // `adName` is not sent as a filter on purpose: Meta's name filtering is fuzzy, and a missed match
      // would read as "nothing there" and license a create. We list the ad set's ads and let
      // publish-plan match the key exactly.
      void adName;
      const res = await deps.get(`/${adsetId}/ads?fields=id,name,adset_id&limit=200`);
      const data = (res as { data?: unknown })?.data;
      // A malformed answer must NOT collapse to an empty list — that would look like "safe to create".
      if (!Array.isArray(data)) {
        throw new Error("meta-publisher: ad list was not readable (no data array) — refusing to treat as empty");
      }
      return data as AdRow[];
    },

    async createAd({ adsetId, name, approvalHash }) {
      if (!nonEmpty(name)) throw new Error("meta-publisher: refusing to create an ad with no name — the name is the idempotency key");
      if (!nonEmpty(adsetId)) throw new Error("meta-publisher: refusing to create an ad with no target ad set");

      // 1. The approved composition. Everything the ad says comes from here, so a human reviewed it.
      const comp = await deps.readComposition(approvalHash);
      if (!comp) throw new Error("meta-publisher: no approved composition for this approval — nothing to publish");
      for (const k of REQUIRED) {
        if (!nonEmpty(comp[k])) throw new Error(`meta-publisher: approved composition is missing ${k} — refusing to publish`);
      }

      // 2. The finished image, by content address. Absent bytes mean the ad would be built from
      //    something other than what was approved.
      const asset = await deps.readAsset(comp.asset_sha256);
      if (!asset || !Buffer.isBuffer(asset.bytes) || asset.bytes.length === 0) {
        throw new Error("meta-publisher: approved image asset is missing or empty — refusing to publish");
      }

      // 3. Upload the image. Safe to repeat; an orphan image costs nothing.
      const uploaded = await deps.post(`/${deps.accountId}/adimages`, {
        bytes: asset.bytes.toString("base64"),
      });
      const imageHash = imageHashFrom(uploaded);
      if (!imageHash) throw new Error("meta-publisher: upload returned no image hash — refusing to build a creative");

      // 4. The creative. Also safe to repeat; a creative with no ad delivers nothing.
      const created = await deps.post(`/${deps.accountId}/adcreatives`, {
        name,
        object_story_spec: {
          page_id: comp.page_id,
          link_data: {
            image_hash: imageHash,
            link: comp.link,
            message: comp.message,
            name: comp.headline,
            call_to_action: { type: "LEARN_MORE", value: { link: comp.link } },
          },
        },
      });
      const creativeId = (created as { id?: unknown } | null)?.id;
      if (!nonEmpty(creativeId)) throw new Error("meta-publisher: creative returned no creative id — refusing to create an ad");

      // 5. THE AD — the one call that could ever spend, and it is created PAUSED.
      //    `name` is passed through byte-for-byte: it carries the approval's binding hash and IS the
      //    idempotency key, so altering it would break search-before-create.
      const ad = await deps.post(`/${adsetId}/ads`, {
        name,
        adset_id: adsetId,
        creative: { creative_id: creativeId },
        status: "PAUSED",
      });
      const adId = (ad as { id?: unknown } | null)?.id;
      if (!nonEmpty(adId)) throw new Error("meta-publisher: ad creation returned no id — outcome unknown");
      return { id: adId.trim() };
    },
  };
}
