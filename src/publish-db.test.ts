import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPublishDb } from "./publish-db.ts";

// The three guard-side reads/writes the publish path needs: consume the approval, read the approved
// composition, read the approved image bytes.
//
// THE PROPERTY THAT MATTERS MOST IS IN readAsset. The approval seals `asset_sha256` — the ADDRESS of the
// image, not the image. If these bytes were returned under a hash that does not match them, the ad a
// human approved and the ad that gets built would be different pictures carrying identical paperwork,
// and every downstream guard would still pass. So the bytes are re-hashed here and refused on mismatch.
//
// Second: `bytea` does not necessarily arrive as a Buffer over Neon's HTTP SQL endpoint — it commonly
// arrives as a `\x…` hex string. Guessing wrong would either corrupt the image or silently refuse every
// publish, so both shapes are handled explicitly and anything else is refused rather than coerced.

function fakeSql(handler: (text: string, params: unknown[]) => Record<string, unknown>[] = () => []) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sql = Object.assign(
    async (text: string, params: unknown[] = []) => { calls.push({ text, params }); return handler(text, params); },
    { calls }
  );
  return sql;
}

const HASH = "3f2c8a91b47d0e65c1a2f8e93b6d47a05c8e1f3b9d2a6c4e7f0b8d5a3c9e2f1d";
const BYTES = Buffer.from("a small pretend png");
const SHA = createHash("sha256").update(BYTES).digest("hex");

const COMP = {
  asset_sha256: SHA, cta: "Apply now", headline: "Cut your card fees",
  link: "https://aps.business/eftpos", message: "Merchants are switching.",
  page_id: "101949619136828", target_entity_id: "120200999888",
};

// ---- consumeApproval ---------------------------------------------------

test("consumeApproval appends to approval_consumptions, idempotently", async () => {
  const sql = fakeSql(() => [{ binding_hash: HASH }]);
  const r = await createPublishDb(sql).consumeApproval(HASH, "ad_1");
  assert.deepEqual(r, { consumed: true });
  assert.match(sql.calls[0].text, /INSERT INTO approval_consumptions/i);
  assert.match(sql.calls[0].text, /ON CONFLICT.*DO NOTHING/is, "re-running after a crash must not double-record");
  assert.deepEqual(sql.calls[0].params, [HASH, "ad_1"]);
});

test("an already-consumed approval reports consumed:false, so 'already published' stays honest", async () => {
  const sql = fakeSql(() => []); // ON CONFLICT DO NOTHING returns no row
  assert.deepEqual(await createPublishDb(sql).consumeApproval(HASH, "ad_1"), { consumed: false });
});

test("consumeApproval refuses unusable input BEFORE touching the database", async () => {
  for (const [h, r] of [["", "ad"], ["nothex", "ad"], [HASH, ""], [HASH, "   "]]) {
    const sql = fakeSql();
    await assert.rejects(() => createPublishDb(sql).consumeApproval(h, r), /consume|hash|ref/i, JSON.stringify([h, r]));
    assert.equal(sql.calls.length, 0);
  }
});

// ---- readComposition ---------------------------------------------------

test("readComposition returns the approved composition", async () => {
  const sql = fakeSql(() => [{ composition: COMP }]);
  assert.deepEqual(await createPublishDb(sql).readComposition(HASH), COMP);
});

test("readComposition parses a jsonb column delivered as a STRING", async () => {
  // Drivers differ on whether jsonb arrives parsed. Returning null for a perfectly good composition
  // would refuse every publish; treating a string as an object would crash later.
  const sql = fakeSql(() => [{ composition: JSON.stringify(COMP) }]);
  assert.deepEqual(await createPublishDb(sql).readComposition(HASH), COMP);
});

test("readComposition returns null for a missing row or an unusable value", async () => {
  for (const rows of [[], [{ composition: null }], [{ composition: "not json" }], [{ composition: 5 }], [{ composition: [] }]]) {
    const sql = fakeSql(() => rows as Record<string, unknown>[]);
    assert.equal(await createPublishDb(sql).readComposition(HASH), null, JSON.stringify(rows));
  }
});

test("readComposition refuses a malformed hash before querying", async () => {
  const sql = fakeSql();
  await assert.rejects(() => createPublishDb(sql).readComposition("nope"), /hash/i);
  assert.equal(sql.calls.length, 0);
});

// ---- readAsset ---------------------------------------------------------

test("readAsset returns the bytes when they hash to the address", async () => {
  const sql = fakeSql(() => [{ bytes: BYTES, mime: "image/png" }]);
  const got = await createPublishDb(sql).readAsset(SHA);
  assert.ok(got && BYTES.equals(got.bytes));
  assert.equal(got!.mime, "image/png");
});

test("readAsset decodes bytea delivered as a \\x hex string", async () => {
  const sql = fakeSql(() => [{ bytes: "\\x" + BYTES.toString("hex"), mime: "image/png" }]);
  const got = await createPublishDb(sql).readAsset(SHA);
  assert.ok(got && BYTES.equals(got.bytes), "hex-encoded bytea must be decoded, not refused");
});

test("THE INTEGRITY CHECK: bytes that do not hash to the address are REFUSED", async () => {
  // Otherwise the approved ad and the built ad are different pictures with identical paperwork.
  const sql = fakeSql(() => [{ bytes: Buffer.from("tampered"), mime: "image/png" }]);
  await assert.rejects(() => createPublishDb(sql).readAsset(SHA), /integrity|mismatch/i);
});

test("readAsset returns null when the asset is simply absent", async () => {
  const sql = fakeSql(() => []);
  assert.equal(await createPublishDb(sql).readAsset(SHA), null);
});

test("readAsset refuses an unreadable byte shape ON SHAPE, not merely via the hash check", async () => {
  // These two guards must stay distinguishable. An earlier version accepted either error message, so
  // replacing the shape check with `Buffer.from(String(v))` still passed — the integrity check caught the
  // coerced garbage instead. That is genuine defence in depth and still fail-closed, but it meant this
  // test could not tell whether the shape check existed at all. It now demands the SHAPE message.
  for (const bad of [null, 42, {}, [], "plain-not-hex"]) {
    const sql = fakeSql(() => [{ bytes: bad, mime: "image/png" }]);
    await assert.rejects(
      () => createPublishDb(sql).readAsset(SHA),
      /readable shape/i,
      `${JSON.stringify(bad)} must be refused for its shape, before any hashing`
    );
  }
});

test("readAsset refuses a malformed address before querying", async () => {
  const sql = fakeSql();
  await assert.rejects(() => createPublishDb(sql).readAsset("short"), /sha|address/i);
  assert.equal(sql.calls.length, 0);
});

test("no read ever selects more than it needs", async () => {
  const sql = fakeSql(() => [{ composition: COMP }]);
  await createPublishDb(sql).readComposition(HASH);
  assert.doesNotMatch(sql.calls[0].text, /SELECT \*/i, "a wildcard select would drag jsonb and bytea around needlessly");
});
