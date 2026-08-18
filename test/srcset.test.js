"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rewriteSrcset, splitTopLevel } = require("../src/rewrite/srcset");

test("splitTopLevel ignores commas inside parentheses", () => {
  const parts = splitTopLevel("a(1,2) 1x, b(3,4) 2x");
  assert.deepEqual(parts, ["a(1,2) 1x", " b(3,4) 2x"]);
});

test("srcset with plain URLs and descriptors is rewritten", () => {
  const out = rewriteSrcset("/a.png 1x, /b.png 2x, /c.png 320w", "https://example.com/");
  assert.match(out, /\/api\/resource\/[A-Za-z0-9_-]+ 1x/);
  assert.match(out, /\/api\/resource\/[A-Za-z0-9_-]+ 2x/);
  assert.match(out, /\/api\/resource\/[A-Za-z0-9_-]+ 320w/);
});

test("srcset containing a data URI with commas is not chopped in half", () => {
  const input =
    'data:image/svg+xml;utf8,<svg viewBox="0 0 10 10"><rect x="0,0" width="10"/></svg> 1x, /b.png 2x';
  const out = rewriteSrcset(input, "https://example.com/");
  assert.ok(out.includes("data:image/svg+xml"));
  assert.match(out, /\/api\/resource\/[A-Za-z0-9_-]+ 2x/);
});
