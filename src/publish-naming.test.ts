import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAdName, bindingHashFromAdName, AD_NAME_MAX } from "./publish-naming.ts";

// The ad-name key. Creation is the ONE non-idempotent write in AdPilot, and it is made safe by searching
// the target ad set for the approval's own name before creating. A single character of drift in this
// format means the search misses, the create repeats, and a second ad spends real money.
//
// The vectors below were originally a CROSS-LANGUAGE contract: publishing lived app-side (JavaScript)
// and guard-side (TypeScript) at once, so two implementations of one key had to agree byte for byte.
// Publishing is now guard-side only and the app-side copy has been deleted, so there is exactly ONE
// implementation again. The vectors are kept anyway — they pin the FORMAT itself, so a well-meaning
// tidy-up of the marker or the hash casing fails a test instead of silently orphaning every ad already
// live under the old name.

const VECTORS = path.join(import.meta.dirname, "publish-name-vectors.json");
const PRESENT = fs.existsSync(VECTORS);
const skipNoApp = PRESENT ? false : "ad-name vectors missing — the name format is unpinned";

type Vector = { name: string; binding_hash: string; ad_name: string };
const vectors: Vector[] = PRESENT ? JSON.parse(fs.readFileSync(VECTORS, "utf8")) : [];

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";

test("the guard reproduces every committed ad-name vector, byte for byte", { skip: skipNoApp }, () => {
  assert.ok(vectors.length >= 3, "the vector set must be meaningful");
  for (const v of vectors) {
    assert.equal(
      buildAdName(v.binding_hash), v.ad_name,
      `${v.name}: the guard and app must agree exactly — a mismatch means search-before-create misses and publishes twice`
    );
  }
});

test("every vector round-trips back to its hash", { skip: skipNoApp }, () => {
  for (const v of vectors) assert.equal(bindingHashFromAdName(v.ad_name), v.binding_hash, v.name);
});

test("the name is deterministic — same hash, same name, always", () => {
  assert.equal(buildAdName(HASH), buildAdName(HASH));
});

test("a hash that is not lowercase 64-hex yields NO NAME AT ALL", () => {
  // Fail-closed: an ad created without the key is invisible to every future search, so each later run
  // would create another one. Refusing to build the name stops the publish before it can spend.
  for (const bad of ["", "   ", "xyz", HASH.toUpperCase(), HASH.slice(0, 63), HASH + "a", ` ${HASH}`, 123 as unknown as string, null as unknown as string]) {
    assert.throws(() => buildAdName(bad), /binding hash/i, JSON.stringify(bad));
  }
});

test("the error never echoes the hash value into logs", () => {
  try {
    buildAdName(HASH.toUpperCase());
    assert.fail("should have thrown");
  } catch (e) {
    assert.doesNotMatch(String((e as Error).message), new RegExp(HASH, "i"), "the message must not carry the value");
  }
});

test("uppercase is refused rather than folded — one approval must not have two valid names", () => {
  assert.throws(() => buildAdName(HASH.toUpperCase()));
});

test("a name that is not ours parses to null, so a human's ad is never adopted", () => {
  for (const notOurs of [
    "Winter promo",
    "",
    "AdPilot",
    "AdPilot [apx:]",
    "AdPilot [apx:tooshort]",
    "[apx:" + HASH.toUpperCase() + "]",
    null as unknown as string,
    undefined as unknown as string,
  ]) {
    assert.equal(bindingHashFromAdName(notOurs), null, JSON.stringify(notOurs));
  }
});

test("the key is still found when a human has edited around it", () => {
  // Ads Manager lets a human rename an ad. As long as the marker survives, the ad is still ours and
  // must be adopted rather than duplicated.
  assert.equal(bindingHashFromAdName(`Copy of AdPilot [apx:${HASH}] (edited)`), HASH);
});

test("the name stays inside the self-imposed length budget", () => {
  assert.ok(buildAdName(HASH).length <= AD_NAME_MAX);
  assert.ok(AD_NAME_MAX <= 200, "the budget must stay far below any plausible Meta limit");
});
