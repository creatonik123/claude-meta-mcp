import { test } from "node:test";
import assert from "node:assert/strict";

// Must equal the Graph API version the app pins in app/lib/meta.js, so both sides of a write read
// and write the same API surface.
const APP_META_API_VERSION = "v23.0";

test("META_API_VERSION defaults to the app's Graph API version", async () => {
  delete process.env.META_API_VERSION;
  process.env.META_ACCESS_TOKEN = "placeholder-not-a-token";
  process.env.AUTH_TOKEN = "placeholder-not-a-token";
  const { config } = await import("./config.ts");
  assert.equal(config.meta.apiVersion, APP_META_API_VERSION);
});
