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
  // The instant form the replacement inherits from the ad it replaces (serializer v2). Leads-objective
  // ad sets REFUSE form-less creatives (subcode 3390001, proven live 2026-08-12) — and every real APS
  // campaign is a leads campaign. Sealed into the approval because the form decides what data is
  // collected from people: a human signs it, it is never read live at publish time.
  lead_gen_form_id?: string;
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

// The composition fields that must be IDENTICAL between two renderings of one creative. The image is
// the only thing allowed to differ — everything a human read on the approval card must match, or the
// two records are not two formats of one ad, they are two different ads.
const COMPANION_MUST_MATCH: Array<keyof Composition> = ["cta", "headline", "link", "message", "page_id", "target_entity_id", "lead_gen_form_id"];

// Verify a companion composition is genuinely the OTHER RENDERING of the same approved creative.
// Throws rather than degrading: silently dropping an unverifiable companion would publish a
// single-image ad while consuming both approvals, losing the vertical with no trace. An ABSENT
// companion is a different case entirely and never reaches here — that is the ordinary one-format ad.
function assertCompanion(primary: Composition, companion: Composition | null, primaryHash: string, companionHash: string): void {
  if (companionHash.trim() === primaryHash.trim()) {
    throw new Error("meta-publisher: companion hash equals the primary hash — refusing to publish");
  }
  if (!companion) {
    throw new Error("meta-publisher: no approved composition for the companion rendering — refusing to publish");
  }
  for (const k of COMPANION_MUST_MATCH) {
    // Compared as strings so undefined on one side and "" on the other cannot read as equal.
    if (String(primary[k] ?? "") !== String(companion[k] ?? "")) {
      throw new Error(`meta-publisher: companion rendering differs on ${k} — refusing to publish (these are not two formats of one creative)`);
    }
  }
  if (!nonEmpty(companion.asset_sha256)) {
    throw new Error("meta-publisher: companion rendering has no image — refusing to publish");
  }
  if (companion.asset_sha256 === primary.asset_sha256) {
    throw new Error("meta-publisher: companion rendering carries the SAME image as the primary — refusing to publish");
  }
}

// The placement-customised creative body. THE SHAPE IS PROVEN, not inferred: verified against the live
// account on 2026-08-28 (creative created, read back, deleted; no ad created). Two Meta rejections
// shaped it and both constraints are load-bearing:
//   * subcode 1885923 — a DEFAULT rule with an EMPTY customization_spec is REQUIRED. It is the catch-all
//     for every placement no other rule names, and it carries the SQUARE, which is the rendering the
//     approval card previewed.
//   * subcode 2446501 "Invalid Targeting Rule For Localization By Location Ad" — labelling and
//     referencing several asset types per rule switches Meta into the location-localization mode, which
//     then demands geolocation in every non-default rule. So ONLY THE IMAGE CARRIES A LABEL; the copy,
//     link and CTA are single unlabelled assets. That is also correct on its own terms: the approval
//     sealed ONE set of words for both renderings.
// A feed rule is deliberately NOT emitted — the empty default already covers feed and everything else.
// The Instagram identity for a two-format creative.
//
// Naming `instagram_positions` in a customization rule makes the ad EXPLICITLY target Instagram, and
// Meta then requires an Instagram identity on the creative. Proven live against this account:
//   code 100 / subcode 1772103 — "Instagram account is missing. Select an Instagram account or
//   Facebook Page to represent your business on Instagram."
// The single-image path never names Instagram, so Meta supplies the identity itself (the working
// creative in the trial ad set carries instagram_user_id unasked). Once we name it, we must too.
//
// Resolved from the PAGE the approval already carries — never a caller argument, never a constant —
// so the identity can only ever be the one belonging to the page a human approved. Refuses rather
// than guessing: an ad that names Instagram with no identity is refused by Meta anyway, so failing
// here with a readable reason beats failing there with "Invalid parameter".
async function instagramIdFor(pageId: string, deps: MetaPublisherDeps): Promise<string> {
  let res: Record<string, unknown>;
  try {
    res = await deps.get(`/${pageId}?fields=instagram_business_account,connected_instagram_account`);
  } catch (e) {
    throw new Error(`meta-publisher: could not read the page's instagram account — refusing to publish (${e instanceof Error ? e.message : String(e)})`);
  }
  const pick = (v: unknown): string => {
    const id = (v as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.trim() !== "" ? id.trim() : "";
  };
  const id = pick(res?.instagram_business_account) || pick(res?.connected_instagram_account);
  if (!id) {
    throw new Error("meta-publisher: the approved page has no linked instagram account, and this creative targets instagram — refusing to publish");
  }
  return id;
}

function twoFormatCreative(name: string, comp: Composition, squareHash: string, verticalHash: string, callToAction: Record<string, unknown>, instagramUserId: string) {
  const SQ = "apx_square";
  const VT = "apx_vertical";
  return {
    name,
    // Page only. link_data here would compete with the feed spec for the same slots.
    object_story_spec: { page_id: comp.page_id },
    // Required because the rules below name instagram_positions. See instagramIdFor above.
    instagram_user_id: instagramUserId,
    asset_feed_spec: {
      images: [
        { hash: squareHash, adlabels: [{ name: SQ }] },
        { hash: verticalHash, adlabels: [{ name: VT }] },
      ],
      bodies: [{ text: comp.message }],
      titles: [{ text: comp.headline }],
      link_urls: [{ website_url: comp.link }],
      ad_formats: ["SINGLE_IMAGE"],
      call_to_action_types: [String((callToAction as { type?: unknown }).type ?? "LEARN_MORE")],
      call_to_actions: [callToAction],
      asset_customization_rules: [
        {
          customization_spec: {
            publisher_platforms: ["facebook", "instagram"],
            facebook_positions: ["story"],
            instagram_positions: ["story"],
          },
          image_label: { name: VT },
        },
        // The required default, lowest priority, empty spec.
        { customization_spec: {}, image_label: { name: SQ } },
      ],
    },
  };
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

    async createAd({ adsetId, name, approvalHash, companionHash }) {
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

      // 3b. The OTHER RENDERING, when one was approved. Both formats belong in ONE ad: the approver
      //     approved one ad, and publishing a second ad for the second format is what produced the
      //     duplicate on 27 Aug. An absent companion is the ordinary single-format ad and changes
      //     nothing below; a companion that cannot be VERIFIED throws, because a silent fallback
      //     would ship one image while both approvals were spent.
      const wantCompanion = nonEmpty(companionHash);
      let companionImageHash: string | null = null;
      let instagramUserId = "";
      if (wantCompanion) {
        const companion = await deps.readComposition(companionHash as string);
        assertCompanion(comp, companion, approvalHash, companionHash as string);
        const companionAsset = await deps.readAsset((companion as Composition).asset_sha256);
        if (!companionAsset || !Buffer.isBuffer(companionAsset.bytes) || companionAsset.bytes.length === 0) {
          throw new Error("meta-publisher: companion rendering's image asset is missing or empty — refusing to publish");
        }
        const companionUploaded = await deps.post(`/${deps.accountId}/adimages`, {
          bytes: companionAsset.bytes.toString("base64"),
        });
        companionImageHash = imageHashFrom(companionUploaded);
        if (!companionImageHash) {
          throw new Error("meta-publisher: companion upload returned no image hash — refusing to build a half creative");
        }
        // Resolved ONLY on this path, so the single-image body — proven in production — is unchanged
        // and costs no extra read.
        instagramUserId = await instagramIdFor(comp.page_id, deps);
      }

      // 4. The creative. Also safe to repeat; a creative with no ad delivers nothing.
      //    With a sealed form: the CTA carries the form and the link leaves the CTA value (a lead ad
      //    collects in-form; the destination link stays on link_data). A BLANK form id is treated as
      //    absent rather than sent — Meta would accept the empty string as a literal form name.
      const formId = typeof comp.lead_gen_form_id === "string" ? comp.lead_gen_form_id.trim() : "";
      const callToAction =
        formId !== ""
          ? { type: "SIGN_UP", value: { lead_gen_form_id: formId } }
          : { type: "LEARN_MORE", value: { link: comp.link } };
      const created = await deps.post(
        `/${deps.accountId}/adcreatives`,
        companionImageHash
          ? twoFormatCreative(name, comp, imageHash, companionImageHash, callToAction as Record<string, unknown>, instagramUserId)
          : {
              name,
              object_story_spec: {
                page_id: comp.page_id,
                link_data: {
                  image_hash: imageHash,
                  link: comp.link,
                  message: comp.message,
                  name: comp.headline,
                  call_to_action: callToAction,
                },
              },
            }
      );
      const creativeId = (created as { id?: unknown } | null)?.id;
      if (!nonEmpty(creativeId)) throw new Error("meta-publisher: creative returned no creative id — refusing to create an ad");

      // 5. THE AD — the one call that could ever spend, and it is created PAUSED.
      //    `name` is passed through byte-for-byte: it carries the approval's binding hash and IS the
      //    idempotency key, so altering it would break search-before-create.
      //    Filed on the ACCOUNT edge: Graph accepts ad creation only at /act_<id>/ads (the ad-set
      //    edge is read-only for ads — proven live 2026-08-12, error 100 "does not support this
      //    operation"). The destination still comes ONLY from the approval, via adset_id below.
      const ad = await deps.post(`/${deps.accountId}/ads`, {
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
