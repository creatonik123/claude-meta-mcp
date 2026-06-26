import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetaWriter, createMetaReader, type GraphClient } from "./meta-adapters.ts";

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
