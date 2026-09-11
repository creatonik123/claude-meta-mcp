import { test } from "node:test";
import assert from "node:assert/strict";
import { waitUntilReady } from "./video-ready.ts";

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
