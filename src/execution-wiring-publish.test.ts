/**
 * The publish wiring: proves the five pieces are really connected to each other and to the
 * managed account — not merely present.
 *
 * Every test here drives the ASSEMBLED object with a fake graph client and a fake `sql`, so a
 * piece that is wired to the wrong thing (production account, a stubbed reader, an unencoded
 * nested body) fails rather than type-checks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildPublishWiring, buildExecutionDeps } from "./execution-wiring.ts";
import { buildAdName } from "./publish-naming.ts";
import { loadGuardConfig } from "./load-config.ts";
import type { GuardConfig } from "./guard.ts";
import type { GraphClient } from "./meta-adapters.ts";
import type { Sql } from "./coordinator-db.ts";
import { createGuardDb } from "./guard-db.ts";

const HASH = "a".repeat(64);
const IMAGE = Buffer.from("a tiny fake png");
const IMAGE_SHA = createHash("sha256").update(IMAGE).digest("hex");
const ADSET = "120200999";

function composition(over: Record<string, unknown> = {}) {
  return {
    asset_sha256: IMAGE_SHA,
    cta: "LEARN_MORE",
    headline: "Zero-cost EFTPOS",
    link: "https://aps.business/eftpos",
    message: "Surcharge-free from Oct 1.",
    page_id: "101949619136828",
    ...over,
  };
}

// A fake `sql` that answers the three real queries by shape, and records every call.
function fakeSql(opts: { comp?: unknown; bytes?: unknown; ads?: unknown } = {}) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sql: Sql & { calls: typeof calls } = Object.assign(
    async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      if (/FROM approval_records/.test(text)) return [{ composition: opts.comp ?? composition() }];
      if (/FROM asset_blobs/.test(text)) return [{ bytes: opts.bytes ?? IMAGE, mime: "image/png" }];
      if (/INSERT INTO approval_consumptions/.test(text)) return [{ binding_hash: HASH }];
      return [];
    },
    { calls }
  );
  return sql;
}

// A fake graph client. `get` answers the ad-set ad list; `post` answers each of the three
// publish calls by path, in the shapes Meta really returns.
function fakeClient(ads: unknown[] = []) {
  const calls = { get: [] as string[], post: [] as Array<{ path: string; body: Record<string, unknown> }> };
  const client: GraphClient & { calls: typeof calls } = {
    calls,
    async get<T = unknown>(path: string) {
      calls.get.push(path);
      return { data: ads } as T;
    },
    async post<T = unknown>(path: string, body: Record<string, unknown> = {}) {
      calls.post.push({ path, body });
      if (/\/adimages$/.test(path)) return { images: { bytes: { hash: "img_hash_1" } } } as T;
      if (/\/adcreatives$/.test(path)) return { id: "creative_1" } as T;
      return { id: "ad_1" } as T;
    },
  };
  return client;
}

function cfg(): GuardConfig {
  return loadGuardConfig();
}

function wiring(sql: Sql, client: GraphClient, config: GuardConfig = cfg()) {
  return buildPublishWiring(sql, client, config, createGuardDb(sql));
}

// ---- the whole chain, driven end to end ------------------------------------

test("createAd files the image and creative against the MANAGED account and creates the ad in the target ad set", async () => {
  const config = cfg();
  const sql = fakeSql();
  const client = fakeClient();
  const w = wiring(sql, client, config);

  const name = buildAdName(HASH);
  const res = await w.publisher.createAd({ adsetId: ADSET, name, approvalHash: HASH });

  assert.deepEqual(res, { id: "ad_1" });
  assert.deepEqual(
    client.calls.post.map((c) => c.path),
    [`/${config.managedAccountId}/adimages`, `/${config.managedAccountId}/adcreatives`, `/${config.managedAccountId}/ads`]
  );
});

test("the production account appears in NO publish call — the writer may only ever file against the sandbox", async () => {
  const config = cfg();
  const client = fakeClient();
  const w = wiring(fakeSql(), client, config);
  await w.publisher.createAd({ adsetId: ADSET, name: buildAdName(HASH), approvalHash: HASH });

  const denied = config.deniedAccountIds ?? [];
  assert.ok(denied.length > 0, "ANCHOR: guard.config.json must list at least one denied account");
  const everything = JSON.stringify(client.calls);
  for (const acct of denied) {
    assert.ok(!everything.includes(acct), `a denied account (${acct}) reached a publish call`);
  }
});

test("the ad is created PAUSED, under exactly the name it was given", async () => {
  const client = fakeClient();
  const w = wiring(fakeSql(), client);
  const name = buildAdName(HASH);
  await w.publisher.createAd({ adsetId: ADSET, name, approvalHash: HASH });

  const ad = client.calls.post[2];
  assert.equal(ad.body.status, "PAUSED");
  assert.equal(ad.body.name, name);
  assert.equal(ad.body.adset_id, ADSET);
});

test("the creative carries the APPROVED copy, JSON-encoded as Graph's form encoding requires", async () => {
  const client = fakeClient();
  const w = wiring(fakeSql(), client);
  await w.publisher.createAd({ adsetId: ADSET, name: buildAdName(HASH), approvalHash: HASH });

  const spec = client.calls.post[1].body.object_story_spec;
  // A nested object here would reach Meta as "[object Object]" — the value must already be a string.
  assert.equal(typeof spec, "string", "object_story_spec must be JSON-encoded, not a live object");
  const parsed = JSON.parse(spec as string);
  const c = composition();
  assert.equal(parsed.page_id, c.page_id);
  assert.equal(parsed.link_data.message, c.message);
  assert.equal(parsed.link_data.name, c.headline);
  assert.equal(parsed.link_data.link, c.link);
  assert.equal(parsed.link_data.image_hash, "img_hash_1");
});

test("the uploaded image is the APPROVED bytes, base64-encoded", async () => {
  const client = fakeClient();
  const w = wiring(fakeSql(), client);
  await w.publisher.createAd({ adsetId: ADSET, name: buildAdName(HASH), approvalHash: HASH });
  assert.equal(client.calls.post[0].body.bytes, IMAGE.toString("base64"));
});

test("the composition is read for THIS approval's hash (not any row that happens to be first)", async () => {
  const sql = fakeSql();
  const w = wiring(sql, fakeClient());
  await w.publisher.createAd({ adsetId: ADSET, name: buildAdName(HASH), approvalHash: HASH });
  const read = sql.calls.find((c) => /FROM approval_records/.test(c.text));
  assert.ok(read, "the composition must be read from approval_records");
  assert.deepEqual(read.params, [HASH]);
});

test("the image is fetched by the address the approval sealed", async () => {
  const sql = fakeSql();
  const w = wiring(sql, fakeClient());
  await w.publisher.createAd({ adsetId: ADSET, name: buildAdName(HASH), approvalHash: HASH });
  const read = sql.calls.find((c) => /FROM asset_blobs/.test(c.text));
  assert.ok(read, "the image must be read from asset_blobs");
  assert.deepEqual(read.params, [IMAGE_SHA]);
});

// ---- the integrity property has to survive the wiring ----------------------

test("bytes that do not hash to the sealed address REFUSE, and nothing is created", async () => {
  const client = fakeClient();
  const w = wiring(fakeSql({ bytes: Buffer.from("a DIFFERENT picture") }), client);
  await assert.rejects(
    () => w.publisher.createAd({ adsetId: ADSET, name: buildAdName(HASH), approvalHash: HASH }),
    /integrity mismatch/
  );
  assert.equal(client.calls.post.length, 0, "no Meta call may be made once integrity fails");
});

test("a bytea arriving as a '\\x…' hex string is decoded, not refused (Neon's HTTP endpoint does this)", async () => {
  const client = fakeClient();
  const w = wiring(fakeSql({ bytes: `\\x${IMAGE.toString("hex")}` }), client);
  await w.publisher.createAd({ adsetId: ADSET, name: buildAdName(HASH), approvalHash: HASH });
  assert.equal(client.calls.post[0].body.bytes, IMAGE.toString("base64"));
});

// ---- search-before-create reads the real ad list ---------------------------

test("searchAdsInAdset asks the graph client for the ad set's ads with the fields the key match needs", async () => {
  const client = fakeClient([{ id: "ad_9", name: "old", adset_id: ADSET }]);
  const w = wiring(fakeSql(), client);
  const rows = await w.publisher.searchAdsInAdset({ adsetId: ADSET, adName: buildAdName(HASH) });
  assert.deepEqual(rows, [{ id: "ad_9", name: "old", adset_id: ADSET }]);
  assert.equal(client.calls.get.length, 1);
  assert.match(client.calls.get[0], /^\/120200999\/ads\?/);
  for (const f of ["id", "name", "adset_id"]) {
    assert.match(client.calls.get[0], new RegExp(f), `the ad list must request ${f}`);
  }
});

// ---- consuming the approval ------------------------------------------------

test("consumeApproval appends to approval_consumptions with the hash and the ad it produced", async () => {
  const sql = fakeSql();
  const w = wiring(sql, fakeClient());
  const out = await w.consumeApproval(HASH, "ad_1");
  assert.deepEqual(out, { consumed: true });
  const ins = sql.calls.find((c) => /INSERT INTO approval_consumptions/.test(c.text));
  assert.ok(ins, "consumption must be an append into approval_consumptions");
  assert.deepEqual(ins.params, [HASH, "ad_1"]);
});

// ---- the doer's re-read must be the guard's own reader ---------------------

test("the doer re-reads the approval through the guard's OWN reader, so the two can never diverge", () => {
  const env = { DATABASE_URL: "postgres://u:p@h/db" };
  const built = buildExecutionDeps(env, fakeClient(), cfg());
  assert.ok(built.doerDeps.publish, "publish must be wired");
  // Identity, not equivalence: two separately-built readers could drift (one consulting
  // approval_consumptions, the other not) and every test would still pass.
  assert.equal(built.doerDeps.publish.approvalByHash, built.guardDeps.db.approvalByHash);
});

test("buildExecutionDeps wires all three publish parts", () => {
  const built = buildExecutionDeps({ DATABASE_URL: "postgres://u:p@h/db" }, fakeClient(), cfg());
  const p = built.doerDeps.publish!;
  assert.equal(typeof p.approvalByHash, "function");
  assert.equal(typeof p.consumeApproval, "function");
  assert.equal(typeof p.publisher.createAd, "function");
  assert.equal(typeof p.publisher.searchAdsInAdset, "function");
});
