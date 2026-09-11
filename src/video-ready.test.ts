import { test } from "node:test";
import assert from "node:assert/strict";
import { waitUntilReady, readThumbnails } from "./video-ready.ts";

// The ONE place allowed to wait. The bound is total: 20 reads, then refuse. Reads cannot spend, and a
// refusal leaves the approval unconsumed. `sleep` is injected, so these run instantly and never touch
// the network.

const VIDEO = "23851234567890123";

function graphOf(statuses: string[]) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    graph: {
      async get(path: string) {
        calls.push(path);
        const s = statuses[Math.min(i++, statuses.length - 1)];
        return { id: VIDEO, status: { video_status: s } };
      },
    },
  };
}

const noSleep = async () => {};

test("resolves as soon as Meta says ready", async () => {
  const { calls, graph } = graphOf(["processing", "processing", "ready"]);
  await waitUntilReady(graph, VIDEO, { sleep: noSleep });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], `/${VIDEO}?fields=status`);
});

test("refuses video_not_ready after exactly 20 attempts", async () => {
  const { calls, graph } = graphOf(["processing"]);
  await assert.rejects(() => waitUntilReady(graph, VIDEO, { sleep: noSleep }), /video_not_ready/);
  assert.equal(calls.length, 20, "the wait must be bounded at 20 reads");
});

test("an error status refuses immediately — no further polling", async () => {
  const { calls, graph } = graphOf(["processing", "error", "ready"]);
  await assert.rejects(() => waitUntilReady(graph, VIDEO, { sleep: noSleep }), /video_not_ready/);
  assert.equal(calls.length, 2);
});

test("waits delayMs BETWEEN polls, never before the first", async () => {
  const slept: number[] = [];
  const { graph } = graphOf(["processing", "processing", "ready"]);
  await waitUntilReady(graph, VIDEO, { delayMs: 3000, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(slept, [3000, 3000]);
});

test("no video id refuses without reading anything", async () => {
  const { calls, graph } = graphOf(["ready"]);
  await assert.rejects(() => waitUntilReady(graph, "  ", { sleep: noSleep }), /video_not_ready/);
  assert.equal(calls.length, 0);
});

// ---- the status shape is tolerated, not assumed -----------------------------
// A read-only probe could not settle which shape this account returns, so all three are read. An
// unrecognised shape reads as "not ready yet" and the bounded wait refuses, which creates nothing.

function graphOfRaw(payloads: unknown[]) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    graph: {
      async get(path: string) {
        calls.push(path);
        return payloads[Math.min(i++, payloads.length - 1)] as Record<string, unknown>;
      },
    },
  };
}

for (const [label, ready, errored] of [
  ["status.video_status", { status: { video_status: "ready" } }, { status: { video_status: "error" } }],
  ["a bare status string", { status: "ready" }, { status: "error" }],
  ["status.status_code", { status: { status_code: "ready" } }, { status: { status_code: "error" } }],
] as Array<[string, unknown, unknown]>) {
  test(`ready is detected from ${label}`, async () => {
    const { calls, graph } = graphOfRaw([ready]);
    await waitUntilReady(graph, VIDEO, { sleep: noSleep });
    assert.equal(calls.length, 1);
  });

  test(`error is detected from ${label}`, async () => {
    const { calls, graph } = graphOfRaw([errored]);
    await assert.rejects(() => waitUntilReady(graph, VIDEO, { sleep: noSleep }), /video_not_ready/);
    assert.equal(calls.length, 1, "an error status stops the wait at once");
  });
}

test("an unreadable status shape refuses after the bound — it is never read as ready", async () => {
  const { calls, graph } = graphOfRaw([{ something_else: true }]);
  await assert.rejects(() => waitUntilReady(graph, VIDEO, { sleep: noSleep }), /video_not_ready/);
  assert.equal(calls.length, 20);
});

// ---- thumbnails lag behind ready --------------------------------------------

test("an empty thumbnail list is re-read, and the populated answer wins", async () => {
  const { calls, graph } = graphOfRaw([{ data: [] }, { data: [] }, { data: [{ uri: "https://x/t.jpg" }] }]);
  const rows = await readThumbnails(graph, VIDEO, { sleep: noSleep });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[0], `/${VIDEO}/thumbnails`);
});

test("thumbnails are re-read at most 5 times, then give up", async () => {
  const { calls, graph } = graphOfRaw([{ data: [] }]);
  const rows = await readThumbnails(graph, VIDEO, { sleep: noSleep });
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 5, "the thumbnail wait is bounded too");
});
