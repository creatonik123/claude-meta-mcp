# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-05-11

Added read-only Product Catalog tools (catalog discovery, feeds, products, diagnostics) — Phase 1 of the Catalog Management roadmap.

### Added — Product Catalogs
- 6 new read-only tools:
  - `list_businesses` — Business Manager discovery via dedup over `/me/adaccounts` and `/me/accounts` (System User tokens get empty `/me/businesses`)
  - `list_product_catalogs` — `/{business_id}/owned_product_catalogs`
  - `get_product_catalog` — single catalog details with business edge
  - `list_product_feeds` — feeds attached to a catalog with `latest_upload` summary
  - `list_catalog_products` — paginated product listing with availability/condition filters
  - `get_catalog_diagnostics` — `/{catalog_id}/diagnostics`; falls back to latest feed-upload error reports when /diagnostics is empty

### Required scopes (additional)
- `catalog_management` — required for all six Catalog tools

In the Meta Developer App, add the Use Case:
- "Produkte mit Catalog API verwalten" (Manage products with Catalog API)

Plus the System User needs explicit asset access to each Catalog in Business Manager → Settings → System Users → `claude-mcp` → Add Assets → **Catalogs**.

### Changed
- `docs/META_APP_SETUP.md`: catalog_management added to required scopes, removed from "deliberately not requested" list.

### Tool count
- v0.3.0: 41 tools
- **v0.4.0: 47 tools** (+6 catalog reads)

### Roadmap (v0.5)
- Phase 1b — Catalog writes: `create_product_catalog`, `create_product_feed`, `update_product_feed_schedule`
- Phase 2 — Signal Diagnostics (Pixel + CAPI health, read-only)

### Breaking
- None. All additive.

## [0.3.0] — 2026-05-06

Added write tools for Meta Ads (campaign/ad set/ad CRUD + asset uploads + creatives) and full Instagram Business account support (publishing, comments, insights).

### Added — Ads write
- 5 asset upload tools: `upload_ad_image`, `list_ad_images`, `upload_ad_video`, `get_video_processing_status`, `list_ad_videos`
- 9 Ads-side write tools: `create_campaign`, `update_campaign`, `delete_campaign`, `create_adset`, `update_adset`, `delete_adset`, `create_ad`, `update_ad`, `delete_ad`
- 2 ad creative tools: `create_ad_creative`, `delete_ad_creative`
- 1 QA tool: `preview_ad` (renders an ad preview HTML for any placement)
- All write tools default to `status: PAUSED` for safety — explicit `ACTIVE` is required to launch ads

### Added — Instagram Business
- 11 Instagram tools:
  - Discovery: `list_instagram_accounts`
  - Read: `list_instagram_posts`, `get_instagram_insights`, `get_instagram_post_insights`
  - Publish: `create_instagram_post` (image/video/reel/story), `create_instagram_carousel`, `delete_instagram_media`
  - Comments: `list_instagram_comments`, `reply_instagram_comment`, `delete_instagram_comment`, `hide_instagram_comment`
- Container-publish 2-phase flow with automatic FINISHED-polling for video/reel processing (up to 90s)

### Added — Client
- `MetaClient.postMultipart()` for multipart/form-data uploads (uses Node 22 native `FormData`/`Blob`)
- `MetaClient.fetchAsBlob()` helper — accepts URL or base64 input, normalizes to Blob

### Required scopes (System User token)
The new tools require these additions to your existing v0.2 scopes:
- `ads_management` (was: `ads_read` only)
- `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`

In the Meta Developer App, add the following Use Cases:
- "Werbeanzeigen mit Marketing API erstellen und verwalten" (Create and manage ads)
- "Messaging und Content auf Instagram verwalten" (Manage messaging and content on Instagram)

For own ad accounts and own IG Business accounts, **no App Review is required** (Standard Access). Advanced Access (App Review + Business Verification) is only needed when other businesses' accounts are managed via this connector.

### Breaking
- None. Existing v0.2 tools continue to work unchanged. New tools are additive.

## [0.2.0] — 2026-05-06

Added Facebook Pages support and switched the recommended token type to System User tokens.

### Added
- 5 new tools for Facebook Pages:
  - `list_pages` (read) — Pages the authenticated System User manages
  - `list_page_posts` (read) — recent posts on a Page
  - `get_page_insights` (read) — Page-level metrics with 2026-valid metric names
  - `create_page_post` (**write**) — publish a new post (text + optional link)
  - `delete_page_post` (**destructive**) — remove a post from a Page
- `MetaClient.post()` and `MetaClient.delete()` for write operations
- `MetaClient.getPageAccessToken()` helper — Page tokens are needed for any Page-scoped write

### Changed
- README + setup docs now recommend Meta System User tokens (never expire) over user access tokens (60-day rotation)
- v0.2 still single-tenant — same `META_ACCESS_TOKEN` + `AUTH_TOKEN` model as v0.1
- Connector is no longer fully read-only. Two write tools require `pages_manage_posts` scope; if you only want read access, remove that scope from the System User and the write tools will fail with 403

### Notes
- `read_insights`, `pages_manage_metadata`, `pages_read_user_content` are *not* required by the current toolset. The 2026 Page Insights metric names changed: `page_impressions` and `page_fans` were deprecated. New defaults: `page_impressions_unique`, `page_post_engagements`, `page_follows`, `page_views_total`.

## [0.1.0] — 2026-05-05

Initial single-tenant alpha release.

### Added
- MCP Streamable HTTP server at `POST /mcp`
- Liveness probe at `GET /health`
- Bearer token auth middleware (single shared secret via `AUTH_TOKEN`)
- Meta Graph API client (axios, v22.0) with pagination helper and structured error wrapping
- 8 read-only tools:
  - `list_ad_accounts`, `get_ad_account`
  - `list_campaigns`, `get_campaign`
  - `list_adsets`, `list_ads`
  - `get_insights` (account / campaign / ad set / ad level, date presets + custom ranges + breakdowns)
  - `list_creatives`
- pm2 example config (`ecosystem.config.cjs`)
- Documentation: `README.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/META_APP_SETUP.md`

### Known limitations
- Single-tenant only — one Meta token, one shared bearer secret.
- No OAuth flow on either side. v0.2 will add OAuth 2.1 + DCR for the Claude side; v0.3 will add Meta OAuth user flow.
- No persistence layer. The Meta token must be refreshed manually every ~60 days.
- No caching. Every tool call hits Graph API directly.
