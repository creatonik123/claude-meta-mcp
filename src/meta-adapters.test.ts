import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetaWriter, createMetaReader, createPublisherGraph, type GraphClient } from "./meta-adapters.ts";

function fakeClient(entity: Record<string, unknown> = { id: "23890", status: "PAUSED", daily_budget: "5000" }) {
  const calls = { get: [] as Array<{ path: string; params: unknown }>, post: [] as Array<{ path: string; body: unknown }> };
  const client: GraphClient & { calls: typeof calls } = {
    calls,
    async get(path, params) {
      calls.get.push({ path, params });
      return entity as never;
    },
    async post(path, body) {
      calls.post.push({ path, body });
      return { success: true } as never;
    },
  };
  return client;
}

test("writer adapter forwards the path and body to the graph client's POST", async () => {
  const client = fakeClient();
  const writer = createMetaWriter(client);
  const result = await writer.post("/23890", { status: "PAUSED" });
  assert.equal(client.calls.post.length, 1);
  assert.deepEqual(client.calls.post[0], { path: "/23890", body: { status: "PAUSED" } });
  assert.deepEqual(result, { success: true });
});

test("reader adapter GETs the entity with comma-joined fields and returns the entity object", async () => {
  const client = fakeClient({ id: "23890", status: "PAUSED" });
  const reader = createMetaReader(client);
  const entity = await reader.get("23890", ["status", "effective_status"]);
  assert.equal(client.calls.get.length, 1);
  assert.equal(client.calls.get[0].path, "/23890");
  assert.deepEqual(client.calls.get[0].params, { fields: "status,effective_status" });
  assert.deepEqual(entity, { id: "23890", status: "PAUSED" });
});

// --- thorough coverage: error propagation, passthrough, field formatting ---

// A client whose calls reject — mimics a Graph API error / network failure.
function throwingClient(err = new Error("Meta Graph API error 17: rate limit")): GraphClient {
  return {
    async get() { throw err; },
    async post() { throw err; },
  };
}

test("writer propagates a client error unchanged (the doer's write-error path relies on this throw)", async () => {
  const err = new Error("Meta Graph API error 613: 4 budget changes/hour");
  const writer = createMetaWriter(throwingClient(err));
  await assert.rejects(() => writer.post("/23890", { daily_budget: 5000 }), /613/);
});

test("writer returns the client's response payload unchanged", async () => {
  const client = fakeClient();
  const writer = createMetaWriter(client);
  const out = await writer.post("/23890", { daily_budget: 5000 });
  assert.deepEqual(out, { success: true });
});

test("writer forwards a budget body (numeric daily_budget) without mutating it", async () => {
  const client = fakeClient();
  const writer = createMetaWriter(client);
  await writer.post("/23890", { daily_budget: 5000 });
  assert.deepEqual(client.calls.post[0].body, { daily_budget: 5000 });
});

test("reader joins a single field with no trailing comma", async () => {
  const client = fakeClient({ status: "PAUSED" });
  const reader = createMetaReader(client);
  await reader.get("23890", ["status"]);
  assert.deepEqual(client.calls.get[0].params, { fields: "status" });
});

test("reader returns the entity object verbatim, including fields it did not ask for", async () => {
  const client = fakeClient({ id: "23890", status: "PAUSED", daily_budget: "5000", effective_status: "ACTIVE" });
  const reader = createMetaReader(client);
  const entity = await reader.get("23890", ["status"]);
  assert.deepEqual(entity, { id: "23890", status: "PAUSED", daily_budget: "5000", effective_status: "ACTIVE" });
});

test("reader returns an empty object verbatim when the entity has no matching fields (doer treats absent field as a mismatch)", async () => {
  const client = fakeClient({});
  const reader = createMetaReader(client);
  const entity = await reader.get("23890", ["status"]);
  assert.deepEqual(entity, {});
});

test("reader propagates a client error unchanged (the doer's read-back-fail path relies on this throw)", async () => {
  const reader = createMetaReader(throwingClient());
  await assert.rejects(() => reader.get("23890", ["status"]), /rate limit/);
});

// ---- the publisher's graph port -------------------------------------------
// The publish path is the only one that sends NESTED bodies (object_story_spec, creative).
// MetaClient.post form-encodes every value with String(), so a nested object would be sent
// literally as "[object Object]". Graph's own convention for form-encoded requests is a
// JSON string per nested field, so the encoding has to happen here.

test("a nested body value is JSON-encoded, never handed to the client as an object", async () => {
  const client = fakeClient();
  const graph = createPublisherGraph(client);
  await graph.post("/act_2218833115522041/adcreatives", {
    name: "apx-1",
    object_story_spec: { page_id: "101949619136828", link_data: { message: "hi", image_hash: "h1" } },
  });
  assert.equal(client.calls.post.length, 1);
  assert.deepEqual(client.calls.post[0].body, {
    name: "apx-1",
    object_story_spec: '{"page_id":"101949619136828","link_data":{"message":"hi","image_hash":"h1"}}',
  });
});

test("scalar body values pass through untouched (a stringified number would still be a number to Graph, but a re-encoded one is a bug)", async () => {
  const client = fakeClient();
  const graph = createPublisherGraph(client);
  await graph.post("/123/ads", { name: "apx-1", adset_id: "999", daily_budget: 5000, is_x: true });
  assert.deepEqual(client.calls.post[0].body, { name: "apx-1", adset_id: "999", daily_budget: 5000, is_x: true });
});

test("an array body value is JSON-encoded", async () => {
  const client = fakeClient();
  const graph = createPublisherGraph(client);
  await graph.post("/123/ads", { fields: ["id", "name"] });
  assert.deepEqual(client.calls.post[0].body, { fields: '["id","name"]' });
});

test("a null body value REFUSES before any call — the alternative is sending the literal 'null' to Meta", async () => {
  const client = fakeClient();
  const graph = createPublisherGraph(client);
  await assert.rejects(() => graph.post("/123/ads", { name: null }), /encodable|cannot encode/i);
  assert.equal(client.calls.post.length, 0);
});

test("an undefined body value REFUSES before any call (a silently dropped field is a differently-shaped ad)", async () => {
  const client = fakeClient();
  const graph = createPublisherGraph(client);
  await assert.rejects(() => graph.post("/123/ads", { name: undefined }), /encodable|cannot encode/i);
  assert.equal(client.calls.post.length, 0);
});

test("a non-finite number REFUSES before any call (String(NaN) would post the text 'NaN')", async () => {
  const client = fakeClient();
  const graph = createPublisherGraph(client);
  await assert.rejects(() => graph.post("/123/ads", { n: NaN }), /encodable|cannot encode/i);
  assert.equal(client.calls.post.length, 0);
});

test("post returns the client's payload and forwards the path verbatim", async () => {
  const client = fakeClient();
  const graph = createPublisherGraph(client);
  const out = await graph.post("/act_1/adimages", { bytes: "AAAA" });
  assert.equal(client.calls.post[0].path, "/act_1/adimages");
  assert.deepEqual(out, { success: true });
});

test("get forwards the path VERBATIM including its query string, and adds no params of its own", async () => {
  const client = fakeClient({ data: [] });
  const graph = createPublisherGraph(client);
  const out = await graph.get("/999/ads?fields=id,name,adset_id&limit=200");
  assert.equal(client.calls.get.length, 1);
  // Re-encoding or stripping this query string would drop the field list, and an ad list with
  // no `name` cannot be matched against the approval key — search-before-create would find
  // nothing and license a duplicate create.
  assert.equal(client.calls.get[0].path, "/999/ads?fields=id,name,adset_id&limit=200");
  assert.deepEqual(out, { data: [] });
});

test("publisher graph propagates a client error unchanged (executePublish's unknown-outcome path relies on this throw)", async () => {
  const graph = createPublisherGraph(throwingClient());
  await assert.rejects(() => graph.post("/123/ads", { name: "apx-1" }), /rate limit/);
});
