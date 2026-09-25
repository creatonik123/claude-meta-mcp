import { test, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { bearerTokenMatches } from "./bearer.ts";

const SECRET = "s3cret-token-value";

test("the exact token is accepted", () => {
  assert.equal(bearerTokenMatches(`Bearer ${SECRET}`, SECRET), true);
  assert.equal(bearerTokenMatches(`bearer ${SECRET}`, SECRET), true);
});

test("a wrong token of the same length is refused", () => {
  const wrong = SECRET.slice(0, -1) + "X";
  assert.equal(wrong.length, SECRET.length);
  assert.equal(bearerTokenMatches(`Bearer ${wrong}`, SECRET), false);
});

test("a token of a different length is refused, never thrown", () => {
  assert.equal(bearerTokenMatches(`Bearer ${SECRET}x`, SECRET), false);
  assert.equal(bearerTokenMatches(`Bearer ${SECRET.slice(1)}`, SECRET), false);
});

test("a missing or non-Bearer header is refused", () => {
  assert.equal(bearerTokenMatches("", SECRET), false);
  assert.equal(bearerTokenMatches(SECRET, SECRET), false);
  assert.equal(bearerTokenMatches(`Basic ${SECRET}`, SECRET), false);
});

test("an empty configured token never matches", () => {
  assert.equal(bearerTokenMatches("Bearer ", ""), false);
  assert.equal(bearerTokenMatches("Bearer x", ""), false);
});

test("the comparison goes through crypto.timingSafeEqual on equal-length buffers", () => {
  const spy = mock.method(crypto, "timingSafeEqual");
  try {
    bearerTokenMatches(`Bearer ${SECRET}`, SECRET);
    assert.equal(spy.mock.callCount(), 1);
    const [a, b] = spy.mock.calls[0].arguments as [Buffer, Buffer];
    assert.equal(a.length, b.length);
  } finally {
    spy.mock.restore();
  }
});

test("the HTTP bearer check uses the constant-time helper, not a string compare", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(src, /bearerTokenMatches\(/);
  assert.doesNotMatch(src, /config\.authToken\s*[!=]==|[!=]==\s*config\.authToken/);
});
