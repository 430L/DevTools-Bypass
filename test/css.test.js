"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rewriteCss } = require("../src/rewrite/css");

const BASE = "https://example.com/dir/style.css";

test("url() with double quotes", () => {
  const out = rewriteCss('a{background:url("/img.png")}', BASE);
  assert.match(out, /\/api\/resource\/[A-Za-z0-9_-]+/);
});

test("url() with single quotes", () => {
  const out = rewriteCss("a{background:url('/img.png')}", BASE);
  assert.match(out, /\/api\/resource\/[A-Za-z0-9_-]+/);
});

test("url() unquoted", () => {
  const out = rewriteCss("a{background:url(/img.png)}", BASE);
  assert.match(out, /\/api\/resource\/[A-Za-z0-9_-]+/);
});

test("data: URIs are left alone", () => {
  const src = 'a{background:url("data:image/png;base64,AAAA")}';
  assert.equal(rewriteCss(src, BASE), src);
});

test("@import string form", () => {
  const out = rewriteCss('@import "reset.css";', BASE);
  assert.match(out, /@import "\/api\/resource\/[A-Za-z0-9_-]+"/);
});

test("@import url() form is rewritten", () => {
  const out = rewriteCss("@import url(reset.css);", BASE);
  assert.match(out, /@import "\/api\/resource\/[A-Za-z0-9_-]+"/);
});

test("cursor: url(...) is rewritten", () => {
  const out = rewriteCss("a{cursor:url(cursor.png), auto}", BASE);
  assert.match(out, /cursor:url\(\/api\/resource\/[A-Za-z0-9_-]+\), auto/);
});

test("image-set() forms have their URLs rewritten", () => {
  const out = rewriteCss("a{background:image-set(url('x.png') 1x, url('y.png') 2x)}", BASE);
  const count = (out.match(/\/api\/resource\//g) || []).length;
  assert.equal(count, 2);
});
