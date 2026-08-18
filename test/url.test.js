"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanTarget,
  encodeTarget,
  decodeTarget,
  proxyEndpoint,
  isNonHttp,
} = require("../src/rewrite/url");

test("cleanTarget resolves relative URLs against a base", () => {
  const u = cleanTarget("/foo", "https://example.com/x");
  assert.equal(u.href, "https://example.com/foo");
});

test("cleanTarget strips credentials", () => {
  const u = cleanTarget("https://user:pass@example.com/x", "https://example.com/");
  assert.equal(u.username, "");
  assert.equal(u.password, "");
});

test("cleanTarget returns null for non-HTTP schemes", () => {
  assert.equal(cleanTarget("javascript:alert(1)", "https://example.com/"), null);
  assert.equal(cleanTarget("data:text/plain,x", "https://example.com/"), null);
  assert.equal(cleanTarget("mailto:x@y.z", "https://example.com/"), null);
});

test("cleanTarget returns null for garbage input", () => {
  assert.equal(cleanTarget("not a url", "not a base"), null);
  assert.equal(cleanTarget("http://[::malformed]", "https://example.com/"), null);
});

test("encodeTarget/decodeTarget round trip", () => {
  const url = "https://example.com/path?q=1&r=abc";
  assert.equal(decodeTarget(encodeTarget(url)), url);
});

test("decodeTarget of oversized input is refused", () => {
  const huge = "a".repeat(10_000);
  assert.equal(decodeTarget(Buffer.from(huge, "utf8").toString("base64url")), "");
});

test("proxyEndpoint shape", () => {
  const u = new URL("https://example.com/x");
  assert.match(proxyEndpoint(u, "page"), /^\/api\/page\/[A-Za-z0-9_-]+$/);
  assert.match(proxyEndpoint(u, "resource"), /^\/api\/resource\/[A-Za-z0-9_-]+$/);
});

test("isNonHttp identifies the usual suspects", () => {
  assert.equal(isNonHttp("data:image/png,foo"), true);
  assert.equal(isNonHttp("javascript:alert(1)"), true);
  assert.equal(isNonHttp("blob:https://example.com/x"), true);
  assert.equal(isNonHttp("mailto:x@y.z"), true);
  assert.equal(isNonHttp("#anchor"), true);
  assert.equal(isNonHttp("/foo"), false);
  assert.equal(isNonHttp("https://x/"), false);
});
