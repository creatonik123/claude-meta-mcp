/**
 * Write-side tools for the Meta connector.
 *
 * Covers:
 *   - Ad Image / Ad Video uploads (multipart + chunked)
 *   - Campaign / Ad Set / Ad CRUD (PAUSED-default for safety)
 *   - Ad Creative create + delete
 *
 * All writes default to status=PAUSED so an accidental tool-call never
 * activates an ad without the user's explicit follow-up.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MetaClient } from "./meta-client.js";

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

function normalizeAdAccountId(id: string): string {
  return id.startsWith("act_") ? id : `act_${id}`;
}

const assetSourceSchema = z
  .object({
    url: z.string().url().optional().describe("Public URL to download the asset from"),
    data_base64: z.string().optional().describe("Base64-encoded asset bytes (alternative to url)"),
    mime: z.string().optional().describe("MIME type override, e.g. image/jpeg"),
    filename: z.string().optional().describe("Optional filename for the upload"),
  })
  .refine((v) => Boolean(v.url) !== Boolean(v.data_base64), {
    message: "Provide exactly one of `url` or `data_base64`",
  });

export function registerWriteTools(server: McpServer, meta: MetaClient): void {
  // ============================================================ Asset uploads

  server.registerTool(
    "upload_ad_image",
    {
      description:
        "Upload an image to an ad account's image library. Returns the image hash (use this in ad creative `image_hash`). WRITE OPERATION.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID (with or without 'act_' prefix)"),
        source: assetSourceSchema,
      },
    },
    async ({ account_id, source }) => {
      const blob = await meta.fetchAsBlob({
        ...source,
        mime: source.mime ?? "image/jpeg",
        filename: source.filename ?? "image.jpg",
      });
      const data = await meta.postMultipart<{
        images?: Record<string, { hash: string; url: string }>;
      }>(`/${normalizeAdAccountId(account_id)}/adimages`, {
        filename: blob,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "list_ad_images",
    {
      description: "List images previously uploaded to this ad account.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ account_id, limit }) => {
      const data = await meta.get(`/${normalizeAdAccountId(account_id)}/adimages`, {
        fields: "hash,name,status,width,height,url,permalink_url,created_time",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "upload_ad_video",
    {
      description:
        "Upload a video to an ad account. Small videos (<50MB) upload in one request. Returns the video ID. " +
        "Videos process asynchronously — use get_video_processing_status to poll readiness. WRITE OPERATION.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        source: assetSourceSchema,
        title: z.string().optional().describe("Optional video title"),
        description: z.string().optional().describe("Optional video description"),
      },
    },
    async ({ account_id, source, title, description }) => {
      const blob = await meta.fetchAsBlob({
        ...source,
        mime: source.mime ?? "video/mp4",
        filename: source.filename ?? "video.mp4",
      });

      // For simplicity, single-shot upload. Meta accepts up to ~1GB on /advideos
      // when sent as multipart, though chunked is recommended for >50MB.
      const data = await meta.postMultipart<{ id?: string }>(
        `/${normalizeAdAccountId(account_id)}/advideos`,
        {
          source: blob,
          title,
          description,
        }
      );
      return asJson(data);
    }
  );

  server.registerTool(
    "get_video_processing_status",
    {
      description:
        "Check whether an uploaded video has finished processing. Returns status_code (e.g. 'ready', 'processing', 'error') and any error reason.",
      inputSchema: {
        video_id: z.string().describe("Video ID returned by upload_ad_video"),
      },
    },
    async ({ video_id }) => {
      const data = await meta.get(`/${video_id}`, {
        fields: "id,status,published,permalink_url,length,source",
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "list_ad_videos",
    {
      description: "List videos uploaded to this ad account.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ account_id, limit }) => {
      const data = await meta.get(`/${normalizeAdAccountId(account_id)}/advideos`, {
        fields: "id,title,description,status,length,permalink_url,created_time",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  // ============================================================ Ad Creatives (write)

  server.registerTool(
    "create_ad_creative",
    {
      description:
        "Create a reusable ad creative (link-ad with image, image-only, or video creative). Required for create_ad. " +
        "WRITE OPERATION. Use upload_ad_image / upload_ad_video first to obtain the image_hash / video_id.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().describe("Internal name for this creative (not shown to users)"),
        page_id: z.string().describe("Facebook Page ID that will own the ad"),
        message: z.string().describe("Primary text shown above the ad creative"),
        link: z.string().url().optional().describe("Destination URL when clicked"),
        link_title: z.string().optional().describe("Headline shown below the image (link ads)"),
        link_description: z.string().optional().describe("Description shown under the headline"),
        image_hash: z.string().optional().describe("Image hash from upload_ad_image (use either image_hash or video_id)"),
        video_id: z.string().optional().describe("Video ID from upload_ad_video"),
        call_to_action: z
          .enum([
            "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "BOOK_TRAVEL", "DOWNLOAD",
            "GET_QUOTE", "SUBSCRIBE", "CONTACT_US", "APPLY_NOW", "GET_OFFER",
            "ORDER_NOW", "MESSAGE_PAGE",
          ])
          .optional()
          .describe("Call-to-action button label"),
        instagram_user_id: z
          .string()
          .optional()
          .describe("Optional Instagram Business Account ID for cross-platform delivery"),
      },
    },
    async ({
      account_id, name, page_id, message, link, link_title, link_description,
      image_hash, video_id, call_to_action, instagram_user_id,
    }) => {
      if (!image_hash && !video_id) {
        throw new Error("Provide either image_hash (from upload_ad_image) or video_id (from upload_ad_video)");
      }
      const cta = call_to_action
        ? { type: call_to_action, value: link ? { link } : undefined }
        : undefined;

      let object_story_spec: Record<string, unknown>;
      if (video_id) {
        object_story_spec = {
          page_id,
          video_data: {
            video_id,
            title: link_title,
            message,
            call_to_action: cta,
            link_description,
          },
        };
      } else {
        object_story_spec = {
          page_id,
          link_data: {
            image_hash,
            link,
            message,
            name: link_title,
            description: link_description,
            call_to_action: cta,
          },
        };
      }
      if (instagram_user_id) object_story_spec.instagram_actor_id = instagram_user_id;

      const data = await meta.post(`/${normalizeAdAccountId(account_id)}/adcreatives`, {
        name,
        object_story_spec: JSON.stringify(object_story_spec),
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "delete_ad_creative",
    {
      description: "Delete an ad creative. DESTRUCTIVE — cannot be undone.",
      inputSchema: { creative_id: z.string().describe("Creative ID") },
    },
    async ({ creative_id }) => {
      const data = await meta.delete(`/${creative_id}`);
      return asJson(data);
    }
  );

  // ============================================================ Campaigns (write)

  server.registerTool(
    "create_campaign",
    {
      description:
        "Create a new campaign. Defaults to status=PAUSED for safety — explicitly set status=ACTIVE to launch. WRITE OPERATION.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().describe("Campaign name"),
        objective: z
          .enum([
            "OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT",
            "OUTCOME_LEADS", "OUTCOME_APP_PROMOTION", "OUTCOME_SALES",
          ])
          .describe("Campaign objective (Outcome-Driven Ad Experience format)"),
        status: z.enum(["ACTIVE", "PAUSED"]).optional().describe("Default: PAUSED"),
        special_ad_categories: z
          .array(z.enum(["NONE", "EMPLOYMENT", "HOUSING", "CREDIT", "ISSUES_ELECTIONS_POLITICS"]))
          .optional()
          .describe("Required for regulated ad categories (default: ['NONE'])"),
        daily_budget_cents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Daily budget in account currency cents (e.g. 1000 = €10.00). Set on Campaign for CBO."),
        lifetime_budget_cents: z.number().int().positive().optional(),
      },
    },
    async ({
      account_id, name, objective, status, special_ad_categories,
      daily_budget_cents, lifetime_budget_cents,
    }) => {
      const body: Record<string, string | number> = {
        name,
        objective,
        status: status ?? "PAUSED",
        special_ad_categories: JSON.stringify(special_ad_categories ?? ["NONE"]),
      };
      if (daily_budget_cents) body.daily_budget = daily_budget_cents;
      if (lifetime_budget_cents) body.lifetime_budget = lifetime_budget_cents;

      const data = await meta.post(`/${normalizeAdAccountId(account_id)}/campaigns`, body);
      return asJson(data);
    }
  );

  server.registerTool(
    "update_campaign",
    {
      description: "Update a campaign's name, status, or budget. WRITE OPERATION.",
      inputSchema: {
        campaign_id: z.string(),
        name: z.string().optional(),
        status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
        daily_budget_cents: z.number().int().positive().optional(),
        lifetime_budget_cents: z.number().int().positive().optional(),
      },
    },
    async ({ campaign_id, name, status, daily_budget_cents, lifetime_budget_cents }) => {
      const body: Record<string, string | number> = {};
      if (name !== undefined) body.name = name;
      if (status !== undefined) body.status = status;
      if (daily_budget_cents) body.daily_budget = daily_budget_cents;
      if (lifetime_budget_cents) body.lifetime_budget = lifetime_budget_cents;
      if (Object.keys(body).length === 0) throw new Error("Nothing to update — provide at least one field");
      const data = await meta.post(`/${campaign_id}`, body);
      return asJson(data);
    }
  );

  server.registerTool(
    "delete_campaign",
    {
      description:
        "Delete (or rather: soft-delete) a campaign by setting its status to DELETED. DESTRUCTIVE.",
      inputSchema: { campaign_id: z.string() },
    },
    async ({ campaign_id }) => {
      const data = await meta.delete(`/${campaign_id}`);
      return asJson(data);
    }
  );

  // ============================================================ Ad Sets (write)

  server.registerTool(
    "create_adset",
    {
      description:
        "Create an ad set inside a campaign. Defaults to status=PAUSED. WRITE OPERATION. " +
        "Targeting is required — see https://developers.facebook.com/docs/marketing-api/audiences/reference/targeting-spec/ for the full spec.",
      inputSchema: {
        account_id: z.string(),
        campaign_id: z.string(),
        name: z.string(),
        daily_budget_cents: z.number().int().positive().optional(),
        lifetime_budget_cents: z.number().int().positive().optional(),
        billing_event: z
          .enum(["IMPRESSIONS", "LINK_CLICKS", "POST_ENGAGEMENT", "PAGE_LIKES", "VIDEO_VIEWS", "THRUPLAY"])
          .default("IMPRESSIONS"),
        optimization_goal: z
          .enum([
            "REACH", "LINK_CLICKS", "IMPRESSIONS", "POST_ENGAGEMENT",
            "PAGE_LIKES", "VIDEO_VIEWS", "THRUPLAY", "LEAD_GENERATION",
            "OFFSITE_CONVERSIONS", "LANDING_PAGE_VIEWS", "QUALITY_LEAD",
          ])
          .describe("Optimization goal — must be compatible with the campaign objective"),
        targeting: z
          .object({
            geo_locations: z
              .object({
                countries: z.array(z.string().length(2)).optional().describe("ISO 3166-1 alpha-2 codes, e.g. ['AT','DE']"),
                cities: z.array(z.object({ key: z.string(), radius: z.number().optional(), distance_unit: z.enum(["mile", "kilometer"]).optional() })).optional(),
              })
              .optional(),
            age_min: z.number().int().min(13).max(65).optional(),
            age_max: z.number().int().min(13).max(65).optional(),
            genders: z.array(z.union([z.literal(1), z.literal(2)])).optional().describe("[1]=men, [2]=women, [1,2]=all"),
            interests: z.array(z.object({ id: z.string(), name: z.string().optional() })).optional(),
            publisher_platforms: z.array(z.enum(["facebook", "instagram", "messenger", "audience_network"])).optional(),
          })
          .describe("Targeting spec — at minimum geo_locations.countries"),
        start_time: z.string().optional().describe("ISO 8601 start time"),
        end_time: z.string().optional().describe("ISO 8601 end time"),
        status: z.enum(["ACTIVE", "PAUSED"]).optional().describe("Default: PAUSED"),
      },
    },
    async ({
      account_id, campaign_id, name,
      daily_budget_cents, lifetime_budget_cents,
      billing_event, optimization_goal, targeting,
      start_time, end_time, status,
    }) => {
      const body: Record<string, string | number> = {
        name,
        campaign_id,
        billing_event,
        optimization_goal,
        targeting: JSON.stringify(targeting),
        status: status ?? "PAUSED",
      };
      if (daily_budget_cents) body.daily_budget = daily_budget_cents;
      if (lifetime_budget_cents) body.lifetime_budget = lifetime_budget_cents;
      if (start_time) body.start_time = start_time;
      if (end_time) body.end_time = end_time;

      const data = await meta.post(`/${normalizeAdAccountId(account_id)}/adsets`, body);
      return asJson(data);
    }
  );

  server.registerTool(
    "update_adset",
    {
      description: "Update an ad set's name, status, budget, or targeting. WRITE OPERATION.",
      inputSchema: {
        adset_id: z.string(),
        name: z.string().optional(),
        status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
        daily_budget_cents: z.number().int().positive().optional(),
        lifetime_budget_cents: z.number().int().positive().optional(),
      },
    },
    async ({ adset_id, name, status, daily_budget_cents, lifetime_budget_cents }) => {
      const body: Record<string, string | number> = {};
      if (name !== undefined) body.name = name;
      if (status !== undefined) body.status = status;
      if (daily_budget_cents) body.daily_budget = daily_budget_cents;
      if (lifetime_budget_cents) body.lifetime_budget = lifetime_budget_cents;
      if (Object.keys(body).length === 0) throw new Error("Nothing to update");
      const data = await meta.post(`/${adset_id}`, body);
      return asJson(data);
    }
  );

  server.registerTool(
    "delete_adset",
    {
      description: "Delete an ad set. DESTRUCTIVE.",
      inputSchema: { adset_id: z.string() },
    },
    async ({ adset_id }) => {
      const data = await meta.delete(`/${adset_id}`);
      return asJson(data);
    }
  );

  // ============================================================ Ads (write)

  server.registerTool(
    "create_ad",
    {
      description:
        "Create an ad inside an ad set. Defaults to status=PAUSED. Requires a creative_id from create_ad_creative.",
      inputSchema: {
        account_id: z.string(),
        adset_id: z.string(),
        creative_id: z.string(),
        name: z.string(),
        status: z.enum(["ACTIVE", "PAUSED"]).optional().describe("Default: PAUSED"),
      },
    },
    async ({ account_id, adset_id, creative_id, name, status }) => {
      const data = await meta.post(`/${normalizeAdAccountId(account_id)}/ads`, {
        name,
        adset_id,
        creative: JSON.stringify({ creative_id }),
        status: status ?? "PAUSED",
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "update_ad",
    {
      description: "Update an ad (name, status, or creative). WRITE OPERATION.",
      inputSchema: {
        ad_id: z.string(),
        name: z.string().optional(),
        status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
        creative_id: z.string().optional().describe("Replace the ad's creative"),
      },
    },
    async ({ ad_id, name, status, creative_id }) => {
      const body: Record<string, string | number> = {};
      if (name !== undefined) body.name = name;
      if (status !== undefined) body.status = status;
      if (creative_id) body.creative = JSON.stringify({ creative_id });
      if (Object.keys(body).length === 0) throw new Error("Nothing to update");
      const data = await meta.post(`/${ad_id}`, body);
      return asJson(data);
    }
  );

  server.registerTool(
    "delete_ad",
    {
      description: "Delete an ad. DESTRUCTIVE.",
      inputSchema: { ad_id: z.string() },
    },
    async ({ ad_id }) => {
      const data = await meta.delete(`/${ad_id}`);
      return asJson(data);
    }
  );

  server.registerTool(
    "preview_ad",
    {
      description:
        "Render a preview of an ad for a given placement (returns HTML iframe markup). " +
        "Useful for QA before activating an ad.",
      inputSchema: {
        ad_id: z.string(),
        ad_format: z
          .enum([
            "DESKTOP_FEED_STANDARD", "MOBILE_FEED_STANDARD", "MOBILE_FEED_BASIC",
            "INSTAGRAM_STANDARD", "INSTAGRAM_STORY", "INSTAGRAM_REELS",
            "FACEBOOK_STORY_MOBILE", "AUDIENCE_NETWORK_OUTSTREAM_VIDEO",
            "MESSENGER_MOBILE_INBOX_MEDIA",
          ])
          .describe("Placement format to render"),
      },
    },
    async ({ ad_id, ad_format }) => {
      const data = await meta.get(`/${ad_id}/previews`, { ad_format });
      return asJson(data);
    }
  );
}
