/**
 * AdPilot read-only safety gate — exact-name allow-list.
 *
 * The upstream server registers 40+ tools, including destructive writes
 * (delete_campaign, update_adset, create_instagram_post, create_page_post …).
 * Until the guarded write tools are built, AdPilot registers ONLY these
 * hand-audited READ tools, matched by EXACT NAME. Any tool not in this set is
 * refused registration, so it never appears in the MCP menu and cannot be
 * called. Upstream tool code is left untouched (recoverable / upstream-syncable);
 * safety comes from this gate, never from deleting files or negating patterns.
 *
 * Verified read-only against src/*.ts on 2026-06-13. Re-audit after any
 * `git pull upstream` before adding a name here.
 */
export const READ_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // ad account + campaign structure (GET)
  "list_ad_accounts", "get_ad_account", "list_campaigns", "get_campaign",
  "list_adsets", "list_ads", "get_insights", "list_creatives",
  // pages (GET)
  "list_pages", "list_page_posts", "get_page_insights",
  // ad assets (GET)
  "list_ad_images", "list_ad_videos", "get_video_processing_status", "preview_ad",
  // instagram (GET)
  "list_instagram_accounts", "list_instagram_posts", "get_instagram_insights",
  "get_instagram_post_insights", "list_instagram_comments",
  // product catalogs (GET)
  "list_businesses", "list_product_catalogs", "get_product_catalog",
  "list_product_feeds", "get_catalog_diagnostics", "list_catalog_products",
]);

/** Whether a tool name is allowed to register (read-only allow-list). */
export function isAllowedReadTool(name: string): boolean {
  return READ_ALLOWLIST.has(name);
}

/**
 * The only write tools that may ever be registered — each routed through the
 * guard. Not yet wired into the live server (kept off until the doer +
 * connectors exist); defined here so the startup assertion can validate them.
 *
 * NOTE for the write-wiring milestone: these are TOOL names; the guard's
 * internal ActionType / config keys are { pause, adjust_adset_budget,
 * publish_approved_creative }. So 'pause_entity' (tool) maps to the 'pause'
 * action. When wiring writes, add an explicit tool-name -> action-type map and
 * a test that the two sets stay in sync — do not assume the strings match.
 */
export const GATED_WRITE_TOOLS: ReadonlySet<string> = new Set<string>([
  "pause_entity",
  "adjust_adset_budget",
  "publish_approved_creative",
]);

/**
 * Known raw upstream WRITE tools (verified against src/*.ts). The startup
 * backstop checks the registered set against THIS independently of the read
 * allow-list — so it still fires if a write name is mistakenly added to the
 * allow-list, not just if it falls outside it.
 */
export const KNOWN_WRITE_TOOLS: ReadonlySet<string> = new Set<string>([
  "create_page_post", "delete_page_post",
  "upload_ad_image", "upload_ad_video", "create_ad_creative", "delete_ad_creative",
  "create_campaign", "update_campaign", "delete_campaign",
  "create_adset", "update_adset", "delete_adset",
  "create_ad", "update_ad", "delete_ad",
  "create_instagram_post", "create_instagram_carousel", "delete_instagram_media",
  "reply_instagram_comment", "delete_instagram_comment", "hide_instagram_comment",
]);

// Catches NEW write tools a future upstream sync might add (verb-prefixed),
// without having to enumerate them. Gated writes are excluded by the caller.
export const WRITE_VERB_PATTERN = /^(create|update|delete|upload|reply|hide|remove|set|publish)_/;
