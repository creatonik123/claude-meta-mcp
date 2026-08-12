#!/usr/bin/env node
/**
 * Seed ONE synthetic approval for the publish smoke test — the supervised first-ever ad creation.
 *
 * Writes three rows the real pipeline would have written (closed candidate package + approval
 * record + content-addressed image), using the APP'S OWN serializer for the binding hash so the
 * hash contract stays honest. The package is inserted with status 'approved' (CLOSED), so it can
 * never collide with a real open packet via the one_open_packet index.
 *
 * Target: the PAUSED sandbox ad set 52623318982820 (campaign 52623318982420, APS 2026).
 * The published ad is born PAUSED inside a PAUSED campaign — double-locked, A$0.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Pool } from "@neondatabase/serverless";

const require = createRequire(import.meta.url);
// The APP's real serializer — the same code that fingerprints every real approval.
const { fingerprint } = require("../../app/lib/creative/fingerprint.js");

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

// A tiny valid PNG (1x1 orange pixel), generated locally — no model spend.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const bytes = Buffer.from(PNG_B64, "base64");
const sha = createHash("sha256").update(bytes).digest("hex");

const composition = {
  asset_sha256: sha,
  cta: "LEARN_MORE",
  headline: "Internal system test",
  link: "https://aps.business",
  message: "Internal system test — never delivered",
  page_id: "101949619136828", // the reviewed PAGES allowlist entry (creative-config.js)
  target_entity_id: "52623318982820", // the sandbox ad set — sealed into the hash
};
const hash = fingerprint(composition);

const pool = new Pool({ connectionString: env.DATABASE_URL });
try {
  const key = `smoke-publish-${hash.slice(0, 12)}`;
  await pool.query(
    `INSERT INTO candidate_packages
       (idempotency_key, claim_token, status, page_id, page_name, entity_id, rule,
        claim_expires_at, stale_after, decided_at, decided_by, approver_class)
     VALUES ($1,'smoke','approved',$2,'Advanced Payment Solutions','52623318982820_smoke','fatigue',
        now(), now() + interval '7 days', now(), 'smoke-test', 'designated')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [key, composition.page_id]
  );
  await pool.query(
    `INSERT INTO asset_blobs (asset_sha256, bytes, mime, provenance)
     VALUES ($1,$2,'image/png','{"source":"smoke-test"}') ON CONFLICT (asset_sha256) DO NOTHING`,
    [sha, bytes]
  );
  await pool.query(
    `INSERT INTO approval_records
       (binding_hash, package_key, composition, serializer_version, approver, approver_class, target_entity_id)
     VALUES ($1,$2,$3,1,'smoke-test','designated',$4) ON CONFLICT (binding_hash) DO NOTHING`,
    [hash, key, JSON.stringify(composition), composition.target_entity_id]
  );
  const check = await pool.query(
    `SELECT binding_hash, target_entity_id,
            (SELECT count(*) FROM approval_consumptions c WHERE c.binding_hash = a.binding_hash)::int AS consumed
       FROM approval_records a WHERE binding_hash = $1`,
    [hash]
  );
  console.log("SEEDED:", JSON.stringify(check.rows[0]));
  console.log("approvalHash:", hash);
} finally {
  await pool.end();
}
