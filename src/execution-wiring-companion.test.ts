import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The tool's inputSchema is the outermost gate. A field that is not in the schema is dropped by the
// MCP layer before any of our code sees it — so if `companionHash` is missing here, the app can send
// it forever and the vertical will never appear, with no error anywhere. That is the single most
// likely way this feature silently does nothing, which is why it is asserted against the source.
//
// This is also the lesson of the two publish bugs (26 Aug): both were a joint where one side sent
// something the other side never read.

const SRC = fs.readFileSync(new URL("./execution-wiring.ts", import.meta.url), "utf8");

// Bounded by the tool entry's own end, not by a character count. A fixed-size window silently stopped
// covering guardArgs the moment a comment was added above it, which made the assertions vacuous rather
// than failing — the same trap that bit two source-reading tests earlier today.
function publishToolBlock(): string {
  const i = SRC.indexOf('name: "publish_approved_creative"');
  assert.notEqual(i, -1, "the publish tool is not registered at all");
  const end = SRC.indexOf("\n  },", i);
  assert.notEqual(end, -1, "could not find the end of the tool entry");
  const block = SRC.slice(i, end);
  assert.ok(block.includes("inputSchema") && block.includes("guardArgs"),
    "the block must contain BOTH sections or these assertions prove nothing");
  return block;
}

test("companionHash is declared in the publish tool's inputSchema", () => {
  const block = publishToolBlock();
  const schema = block.slice(block.indexOf("inputSchema"), block.indexOf("guardArgs"));
  assert.match(schema, /companionHash/, "not in the schema means the MCP layer strips it before we see it");
});

test("companionHash is OPTIONAL — a single-format approval must still publish", () => {
  const block = publishToolBlock();
  const schema = block.slice(block.indexOf("inputSchema"), block.indexOf("guardArgs"));
  const line = schema.split("\n").find((l) => l.includes("companionHash")) || "";
  assert.match(line, /\.optional\(\)/, "a required companionHash would break every ordinary one-image ad");
});

test("guardArgs FORWARDS companionHash — parsing it and dropping it is the classic dead joint", () => {
  const block = publishToolBlock();
  const guardArgs = block.slice(block.indexOf("guardArgs"));
  assert.match(guardArgs, /companionHash/, "parsed but not forwarded means the vertical is silently lost");
});

test("the primary approvalHash is still forwarded, unchanged", () => {
  const block = publishToolBlock();
  const guardArgs = block.slice(block.indexOf("guardArgs"));
  assert.match(guardArgs, /approvalHash/);
});

test("executePublish's own signature accepts companionHash", () => {
  // Cross-file: the wiring may forward a field the doer never destructures.
  const doer = fs.readFileSync(new URL("./doer-publish.ts", import.meta.url), "utf8");
  const i = doer.indexOf("export async function executePublish");
  const sig = doer.slice(i, i + 400);
  assert.match(sig, /companionHash/, "forwarded by the wiring but not read by the doer is the same dead joint");
});

test("the publisher interface accepts companionHash", () => {
  const doer = fs.readFileSync(new URL("./doer-publish.ts", import.meta.url), "utf8");
  const i = doer.indexOf("createAd(args:");
  const sig = doer.slice(i, i + 260);
  assert.match(sig, /companionHash/);
});
