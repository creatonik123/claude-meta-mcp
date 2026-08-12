/**
 * The three guard-side DB operations the publish path needs, over the same injected `sql` the rest of
 * the guard uses: spend the approval, read the approved composition, read the approved image bytes.
 *
 * ═══ THE PROPERTY THAT MATTERS MOST IS IN readAsset ═══
 * An approval seals `asset_sha256` — the ADDRESS of the image, never the image itself. If bytes were
 * returned under an address that does not match them, the ad a human approved and the ad that gets built
 * would be different pictures carrying identical paperwork, and every downstream guard would still pass.
 * So the bytes are re-hashed here and refused on mismatch. This is the only place that check can happen,
 * because it is the only place that sees both the address and the bytes.
 *
 * ═══ AND bytea IS NOT NECESSARILY A Buffer ═══
 * Over Neon's HTTP SQL endpoint a bytea commonly arrives as a `\x…` hex string rather than a Buffer.
 * Guessing wrong would either corrupt the image or silently refuse every publish, so both shapes are
 * handled explicitly and anything else is refused rather than coerced. The integrity check above then
 * catches any decoding mistake regardless.
 *
 * Everything refuses before querying on unusable input, and nothing retries.
 */
import { createHash } from "node:crypto";
import type { Sql } from "./coordinator-db.js";
import type { Composition } from "./meta-publisher.js";

const HEX64 = /^[0-9a-f]{64}$/;

function sha256Hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

// A bytea from any of the shapes a driver may hand us. Returns null for anything we cannot decode
// with certainty — never a guess, because the result becomes the picture in a live ad.
function toBuffer(v: unknown): Buffer | null {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === "string" && v.startsWith("\\x")) {
    const hex = v.slice(2);
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return null;
    return Buffer.from(hex, "hex");
  }
  return null;
}

export interface PublishDb {
  consumeApproval(bindingHash: string, publishedRef: string): Promise<{ consumed: boolean }>;
  readComposition(bindingHash: string): Promise<Composition | null>;
  readAsset(sha256: string): Promise<{ bytes: Buffer; mime: string } | null>;
}

export function createPublishDb(sql: Sql): PublishDb {
  return {
    // Spend the approval as an APPEND (app migration 0011). approval_records is append-only at the DB
    // level, so this cannot be a column update. ON CONFLICT DO NOTHING makes it safe to re-run after a
    // crash: the bookkeeping around a non-idempotent write must never itself become one.
    //
    // `consumed: true` means THIS call recorded it. false means it was already spent — which lets the
    // caller report "already published" honestly instead of as a fresh success.
    async consumeApproval(bindingHash: string, publishedRef: string) {
      const h = typeof bindingHash === "string" ? bindingHash.trim() : "";
      const ref = typeof publishedRef === "string" ? publishedRef.trim() : "";
      if (!HEX64.test(h)) throw new Error("publish-db: cannot consume — binding hash must be lowercase 64-hex");
      // A consumption with no ad reference would claim the approval was spent while losing the only
      // pointer to what it bought.
      if (ref === "") throw new Error("publish-db: cannot consume — a published ref is required");
      const rows = await sql(
        `INSERT INTO approval_consumptions (binding_hash, published_ref)
         VALUES ($1,$2) ON CONFLICT (binding_hash) DO NOTHING RETURNING binding_hash`,
        [h, ref]
      );
      return { consumed: rows.length > 0 };
    },

    // The approved composition — the object whose fingerprint IS the binding hash. Everything the ad
    // says comes from here, which is what makes "a human approved this ad" true rather than nominal.
    async readComposition(bindingHash: string) {
      const h = typeof bindingHash === "string" ? bindingHash.trim() : "";
      if (!HEX64.test(h)) throw new Error("publish-db: readComposition needs a lowercase 64-hex binding hash");
      const rows = await sql(`SELECT composition FROM approval_records WHERE binding_hash = $1`, [h]);
      if (rows.length === 0) return null;
      let c: unknown = rows[0].composition;
      // jsonb may arrive parsed or as a string depending on the driver. Returning null for a perfectly
      // good composition would refuse every publish; treating a string as an object would crash later.
      if (typeof c === "string") {
        try { c = JSON.parse(c); } catch { return null; }
      }
      if (!c || typeof c !== "object" || Array.isArray(c)) return null;
      return c as Composition;
    },

    // The approved image, by content address — and verified against it.
    async readAsset(sha256: string) {
      const addr = typeof sha256 === "string" ? sha256.trim() : "";
      if (!HEX64.test(addr)) throw new Error("publish-db: readAsset needs a lowercase 64-hex content address (sha)");
      const rows = await sql(`SELECT bytes, mime FROM asset_blobs WHERE asset_sha256 = $1`, [addr]);
      if (rows.length === 0) return null; // absent is a normal answer
      const bytes = toBuffer(rows[0].bytes);
      if (!bytes || bytes.length === 0) {
        throw new Error("publish-db: asset bytes were not in a readable shape — refusing to guess the image");
      }
      const actual = sha256Hex(bytes);
      if (actual !== addr) {
        // The approval sealed the address. Different bytes mean a different picture under the same
        // paperwork, so this must never be published.
        throw new Error(`publish-db: asset integrity mismatch for ${addr} — stored bytes hash to ${actual}`);
      }
      const mime = typeof rows[0].mime === "string" && rows[0].mime.trim() !== "" ? rows[0].mime.trim() : "image/png";
      return { bytes, mime };
    },
  };
}
