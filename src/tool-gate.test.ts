import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedReadTool, READ_ALLOWLIST } from "./tool-gate.ts";

// Every WRITE tool the upstream server defines (verified against src/*.ts).
// The gate must refuse registration for each — this is the PRD Day-3
// "blocked-tool refuses" case.
const WRITE_TOOLS = [
  // tools.ts (hidden among the reads)
  "create_page_post", "delete_page_post",
  // tools-write.ts
  "upload_ad_image", "upload_ad_video", "create_ad_creative", "delete_ad_creative",
  "create_campaign", "update_campaign", "delete_campaign",
  "create_adset", "update_adset", "delete_adset",
  "create_ad", "update_ad", "delete_ad",
  // tools-instagram.ts
  "create_instagram_post", "create_instagram_carousel", "delete_instagram_media",
  "reply_instagram_comment", "delete_instagram_comment", "hide_instagram_comment",
];

const READ_TOOLS = [
  "list_campaigns", "get_insights", "list_ad_accounts", "list_creatives",
  "preview_ad", "list_instagram_posts", "list_product_catalogs", "get_ad_account",
];

test("blocked-tool: every write tool is REFUSED registration", () => {
  for (const name of WRITE_TOOLS) {
    assert.equal(isAllowedReadTool(name), false, `write tool '${name}' must NOT be allowed`);
  }
});

test("read tools ARE allowed to register", () => {
  for (const name of READ_TOOLS) {
    assert.equal(isAllowedReadTool(name), true, `read tool '${name}' should be allowed`);
  }
});

test("allow-list contains no known write tool", () => {
  for (const name of WRITE_TOOLS) {
    assert.ok(!READ_ALLOWLIST.has(name), `allow-list must not contain write tool '${name}'`);
  }
});

test("an unknown/typo tool name is refused (default-deny)", () => {
  assert.equal(isAllowedReadTool("list_campaign"), false); // typo (missing 's')
  assert.equal(isAllowedReadTool(""), false);
  assert.equal(isAllowedReadTool("delete_everything"), false);
});
