import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The field crosses SEVEN joints between the app deciding to publish and Meta receiving it:
//   app driver -> app executor arg allowlist -> tool inputSchema -> guardArgs -> guard validateArgs
//   -> guard effectiveArgs -> doer.ts -> executePublish -> publisher.
// Five of those already dropped or refused it before this change. Each is now covered by a behavioural
// test except this one, which is the hand-off inside doer.ts — asserted against the source because the
// surrounding function needs the whole live wiring to run.
const SRC = fs.readFileSync(new URL("./doer.ts", import.meta.url), "utf8");

function runPublishBody(): string {
  const i = SRC.indexOf("await executePublish(");
  assert.notEqual(i, -1, "doer.ts never calls executePublish");
  return SRC.slice(Math.max(0, i - 1200), i + 1200);
}

test("doer.ts reads companionHash out of the guard's effectiveArgs", () => {
  assert.match(runPublishBody(), /args\.companionHash/, "not read here means the vertical dies at the last joint");
});

test("doer.ts FORWARDS companionHash into executePublish", () => {
  const i = SRC.indexOf("await executePublish(");
  const call = SRC.slice(i, i + 400);
  assert.match(call, /companionHash/, "read but not forwarded is the same dead joint");
});

test("the destination is STILL taken from the primary approval, not from args", () => {
  const i = SRC.indexOf("await executePublish(");
  const call = SRC.slice(i, i + 400);
  assert.match(call, /targetEntityId:\s*target/, "the target must remain the approval record's own");
  assert.doesNotMatch(call, /targetEntityId:\s*args\./, "a caller-supplied destination would be a scope hole");
});

test("doer.ts supplies the companion freshness check", () => {
  assert.match(runPublishBody(), /isApprovalConsumed/, "without it the check is absent and every companion is dropped");
});

test("the freshness check treats an unreadable approval as SPENT", () => {
  const body = runPublishBody();
  const i = body.indexOf("isApprovalConsumed");
  const fn = body.slice(i, i + 300);
  assert.match(fn, /!a \|\| a\.consumed !== false/, "unprovable freshness must not read as fresh");
});
