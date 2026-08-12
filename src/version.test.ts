/**
 * The whole point of these tests: a deploy must be identifiable from OUTSIDE.
 * On 2026-08-12 a schema migration was blocked for a day because nobody could
 * tell which bundle was live — /health reported a version that never changed
 * between commits. These pin the two facts that make that impossible again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION, buildInfo } from "./version.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
);

test("VERSION is the package.json version — one source of truth, no drift", () => {
  assert.equal(VERSION, pkg.version);
});

test("buildInfo carries the deploy commit from Vercel's env", () => {
  const info = buildInfo({ VERCEL_GIT_COMMIT_SHA: "23a9a43deadbeef" });
  assert.equal(info.version, pkg.version);
  assert.equal(info.commit, "23a9a43deadbeef");
});

test("no commit env -> commit is 'unknown', never absent or empty", () => {
  const info = buildInfo({});
  assert.equal(info.commit, "unknown");
});

test("a blank commit env is treated as unknown, not echoed", () => {
  assert.equal(buildInfo({ VERCEL_GIT_COMMIT_SHA: "   " }).commit, "unknown");
});
