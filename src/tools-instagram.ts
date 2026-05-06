/**
 * Instagram Graph API tools.
 *
 * The Instagram Graph API is a separate surface that hangs off Pages: every
 * Instagram Business / Creator account is connected to one Facebook Page,
 * and we discover IG accounts by walking /me/accounts and asking each Page
 * for its `instagram_business_account` field.
 *
 * Publishing is a 2-phase upload: create a media container, then publish it.
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

interface PageWithIg {
  id: string;
  name: string;
  access_token?: string;
  instagram_business_account?: { id: string };
}

/**
 * Poll the media container until it's FINISHED (or hits a timeout / error state).
 * Reels and videos take 5–60s to process server-side before they can be published.
 */
async function waitForContainerReady(
  meta: MetaClient,
  containerId: string,
  pageToken: string,
  maxWaitMs = 90_000
): Promise<{ status: string; status_code?: string }> {
  const start = Date.now();
  let delay = 1500;
  while (Date.now() - start < maxWaitMs) {
    const status = await meta.get<{ status_code?: string; status?: string }>(`/${containerId}`, {
      access_token: pageToken,
      fields: "status,status_code",
    });
    if (status.status_code === "FINISHED") return { status: "ready", status_code: status.status_code };
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new Error(`Instagram media container ${containerId} entered ${status.status_code} — upload failed`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 6000);
  }
  throw new Error(`Instagram media container ${containerId} did not reach FINISHED within ${maxWaitMs}ms`);
}

export function registerInstagramTools(server: McpServer, meta: MetaClient): void {
  // -------------------------------------------------------------- Account discovery

  server.registerTool(
    "list_instagram_accounts",
    {
      description:
        "List Instagram Business / Creator accounts connected to Pages the System User manages. " +
        "Each entry returns the IG user ID (use this for posts, insights, comments).",
      inputSchema: {},
    },
    async () => {
      const pages = await meta.get<{ data: PageWithIg[] }>("/me/accounts", {
        fields: "id,name,instagram_business_account{id,username,name,profile_picture_url,followers_count,media_count,biography}",
        limit: 100,
      });
      const out = (pages.data ?? [])
        .filter((p) => p.instagram_business_account)
        .map((p) => ({
          page_id: p.id,
          page_name: p.name,
          instagram: p.instagram_business_account,
        }));
      return asJson({ data: out });
    }
  );

  // -------------------------------------------------------------- Read

  server.registerTool(
    "list_instagram_posts",
    {
      description: "List recent media items (posts, reels, stories) on an Instagram Business Account.",
      inputSchema: {
        ig_user_id: z.string().describe("Instagram Business Account ID (from list_instagram_accounts)"),
        page_id: z.string().describe("Connected Facebook Page ID (for Page Token lookup)"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ ig_user_id, page_id, limit }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.get(`/${ig_user_id}/media`, {
        access_token: pageToken,
        fields:
          "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "get_instagram_insights",
    {
      description:
        "Fetch insights metrics for an Instagram Business account (reach, impressions, profile_views, follower_count). " +
        "Provide either a date_preset OR a since/until pair.",
      inputSchema: {
        ig_user_id: z.string(),
        page_id: z.string().describe("Connected Facebook Page ID"),
        metrics: z
          .array(z.string())
          .optional()
          .describe("Metric names. Default: reach, impressions, profile_views, follower_count"),
        period: z.enum(["day", "week", "days_28"]).optional(),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      },
    },
    async ({ ig_user_id, page_id, metrics, period, since, until }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const params: Record<string, string | number> = {
        access_token: pageToken,
        metric: (metrics ?? ["reach", "impressions", "profile_views", "follower_count"]).join(","),
        period: period ?? "day",
      };
      if (since) params.since = since;
      if (until) params.until = until;
      const data = await meta.get(`/${ig_user_id}/insights`, params);
      return asJson(data);
    }
  );

  server.registerTool(
    "get_instagram_post_insights",
    {
      description: "Fetch per-post insights (engagement, reach, impressions, saves) for a single IG media item.",
      inputSchema: {
        media_id: z.string().describe("IG media item ID"),
        page_id: z.string().describe("Connected Page ID for token lookup"),
        metrics: z.array(z.string()).optional().describe("Default: engagement, reach, impressions, saved"),
      },
    },
    async ({ media_id, page_id, metrics }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.get(`/${media_id}/insights`, {
        access_token: pageToken,
        metric: (metrics ?? ["engagement", "reach", "impressions", "saved"]).join(","),
      });
      return asJson(data);
    }
  );

  // -------------------------------------------------------------- Publishing

  server.registerTool(
    "create_instagram_post",
    {
      description:
        "Publish a single image, video, or reel to an Instagram Business account. WRITE OPERATION. " +
        "Image/Video must be reachable via a public URL (Meta downloads it server-side). " +
        "For carousels (multi-image), use create_instagram_carousel. " +
        "Reels/videos are processed asynchronously — this tool waits up to 90s for the container to finish before publishing.",
      inputSchema: {
        ig_user_id: z.string().describe("Instagram Business Account ID"),
        page_id: z.string().describe("Connected Facebook Page ID (for token lookup)"),
        media_type: z.enum(["IMAGE", "VIDEO", "REELS", "STORIES"]).describe("Type of media to publish"),
        image_url: z.string().url().optional().describe("Public URL of the image (for IMAGE)"),
        video_url: z.string().url().optional().describe("Public URL of the video (for VIDEO/REELS/STORIES)"),
        caption: z.string().optional().describe("Caption text (max 2200 chars). Hashtags allowed."),
        thumb_offset: z.number().int().nonnegative().optional().describe("For VIDEO/REELS: ms offset for the cover frame"),
        location_id: z.string().optional().describe("Optional Facebook Place ID for location tag"),
      },
    },
    async ({ ig_user_id, page_id, media_type, image_url, video_url, caption, thumb_offset, location_id }) => {
      const pageToken = await meta.getPageAccessToken(page_id);

      const containerBody: Record<string, string | number> = {};
      if (media_type === "IMAGE") {
        if (!image_url) throw new Error("media_type IMAGE requires image_url");
        containerBody.image_url = image_url;
      } else {
        if (!video_url) throw new Error(`media_type ${media_type} requires video_url`);
        containerBody.video_url = video_url;
        containerBody.media_type = media_type;
        if (thumb_offset !== undefined) containerBody.thumb_offset = thumb_offset;
      }
      if (caption) containerBody.caption = caption;
      if (location_id) containerBody.location_id = location_id;

      // Phase 1: create container
      const container = await meta.post<{ id: string }>(
        `/${ig_user_id}/media`,
        containerBody,
        { access_token: pageToken }
      );

      // Phase 2 (videos/reels): wait for FINISHED before publishing
      if (media_type !== "IMAGE") {
        await waitForContainerReady(meta, container.id, pageToken);
      }

      // Phase 3: publish
      const published = await meta.post<{ id: string }>(
        `/${ig_user_id}/media_publish`,
        { creation_id: container.id },
        { access_token: pageToken }
      );

      return asJson({ container_id: container.id, media_id: published.id });
    }
  );

  server.registerTool(
    "create_instagram_carousel",
    {
      description:
        "Publish a multi-item carousel (2–10 images/videos) to an Instagram Business account. WRITE OPERATION.",
      inputSchema: {
        ig_user_id: z.string(),
        page_id: z.string(),
        items: z
          .array(
            z.object({
              type: z.enum(["IMAGE", "VIDEO"]).describe("Carousel child media type"),
              image_url: z.string().url().optional(),
              video_url: z.string().url().optional(),
            })
          )
          .min(2)
          .max(10),
        caption: z.string().optional(),
      },
    },
    async ({ ig_user_id, page_id, items, caption }) => {
      const pageToken = await meta.getPageAccessToken(page_id);

      // 1. Create one child container per item
      const childIds: string[] = [];
      for (const item of items) {
        const body: Record<string, string | number> = { is_carousel_item: "true" };
        if (item.type === "IMAGE") {
          if (!item.image_url) throw new Error("Carousel IMAGE item requires image_url");
          body.image_url = item.image_url;
        } else {
          if (!item.video_url) throw new Error("Carousel VIDEO item requires video_url");
          body.video_url = item.video_url;
          body.media_type = "VIDEO";
        }
        const child = await meta.post<{ id: string }>(`/${ig_user_id}/media`, body, {
          access_token: pageToken,
        });
        if (item.type === "VIDEO") {
          await waitForContainerReady(meta, child.id, pageToken);
        }
        childIds.push(child.id);
      }

      // 2. Create the carousel container referencing the children
      const carouselBody: Record<string, string | number> = {
        media_type: "CAROUSEL",
        children: childIds.join(","),
      };
      if (caption) carouselBody.caption = caption;
      const carousel = await meta.post<{ id: string }>(`/${ig_user_id}/media`, carouselBody, {
        access_token: pageToken,
      });

      // 3. Publish
      const published = await meta.post<{ id: string }>(`/${ig_user_id}/media_publish`, {
        creation_id: carousel.id,
      }, { access_token: pageToken });

      return asJson({
        child_container_ids: childIds,
        carousel_container_id: carousel.id,
        media_id: published.id,
      });
    }
  );

  server.registerTool(
    "delete_instagram_media",
    {
      description: "Delete an Instagram media item (post/reel/story). DESTRUCTIVE.",
      inputSchema: {
        media_id: z.string(),
        page_id: z.string().describe("Connected Page ID for token lookup"),
      },
    },
    async ({ media_id, page_id }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.delete(`/${media_id}`, { access_token: pageToken });
      return asJson(data);
    }
  );

  // -------------------------------------------------------------- Comments

  server.registerTool(
    "list_instagram_comments",
    {
      description: "List comments on an IG media item.",
      inputSchema: {
        media_id: z.string(),
        page_id: z.string().describe("Connected Page ID for token lookup"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ media_id, page_id, limit }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.get(`/${media_id}/comments`, {
        access_token: pageToken,
        fields: "id,text,username,timestamp,like_count,replies",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "reply_instagram_comment",
    {
      description: "Reply to a comment on an IG post. WRITE OPERATION.",
      inputSchema: {
        comment_id: z.string().describe("ID of the comment to reply to"),
        page_id: z.string().describe("Connected Page ID for token lookup"),
        message: z.string().min(1).describe("Reply text"),
      },
    },
    async ({ comment_id, page_id, message }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.post(
        `/${comment_id}/replies`,
        { message },
        { access_token: pageToken }
      );
      return asJson(data);
    }
  );

  server.registerTool(
    "delete_instagram_comment",
    {
      description: "Delete a comment from an IG post. DESTRUCTIVE.",
      inputSchema: {
        comment_id: z.string(),
        page_id: z.string().describe("Connected Page ID for token lookup"),
      },
    },
    async ({ comment_id, page_id }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.delete(`/${comment_id}`, { access_token: pageToken });
      return asJson(data);
    }
  );

  server.registerTool(
    "hide_instagram_comment",
    {
      description: "Hide or unhide a comment from public view (less destructive than delete). WRITE OPERATION.",
      inputSchema: {
        comment_id: z.string(),
        page_id: z.string().describe("Connected Page ID for token lookup"),
        hide: z.boolean().describe("true to hide, false to unhide"),
      },
    },
    async ({ comment_id, page_id, hide }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.post(`/${comment_id}`, { hide }, { access_token: pageToken });
      return asJson(data);
    }
  );
}
