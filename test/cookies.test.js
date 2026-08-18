"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  jarFor,
  jarKey,
  storeSetCookies,
  getCookieHeader,
  dropSession,
} = require("../src/proxy/cookies");

test("cookies are scoped per session", async () => {
  const target = new URL("https://example.com/x");
  await storeSetCookies("sid-A", target, ["a=1; Path=/"]);
  await storeSetCookies("sid-B", target, ["a=2; Path=/"]);

  const a = await getCookieHeader("sid-A", target);
  const b = await getCookieHeader("sid-B", target);
  assert.match(a, /a=1/);
  assert.match(b, /a=2/);
  dropSession("sid-A");
  dropSession("sid-B");
});

test("Domain=parent.example.com cookies flow to subdomains", async () => {
  await storeSetCookies("sid-sso", new URL("https://accounts.example.com/"), [
    "sso=abc; Domain=example.com; Path=/",
  ]);
  const other = await getCookieHeader("sid-sso", new URL("https://app.example.com/"));
  assert.match(other, /sso=abc/);
  dropSession("sid-sso");
});

test("Domain-less cookies stay on their host", async () => {
  await storeSetCookies("sid-scoped", new URL("https://alpha.example.com/"), ["s=alpha; Path=/"]);
  const beta = await getCookieHeader("sid-scoped", new URL("https://beta.example.com/"));
  assert.equal(beta.includes("s=alpha"), false);
  dropSession("sid-scoped");
});

test("jars for different registrable domains stay independent", async () => {
  await storeSetCookies("sid-cross", new URL("https://example.com/"), ["s=ex; Path=/"]);
  await storeSetCookies("sid-cross", new URL("https://other.com/"), ["s=ot; Path=/"]);
  const ex = await getCookieHeader("sid-cross", new URL("https://example.com/"));
  const ot = await getCookieHeader("sid-cross", new URL("https://other.com/"));
  assert.match(ex, /s=ex/);
  assert.equal(ex.includes("s=ot"), false);
  assert.match(ot, /s=ot/);
  dropSession("sid-cross");
});

test("jarKey returns eTLD+1 for public hosts and falls back to raw hostname otherwise", () => {
  assert.equal(jarKey("www.example.com"), "example.com");
  assert.equal(jarKey("a.b.c.example.co.uk"), "example.co.uk");
  // Bare host or IP → fall through to the raw hostname.
  assert.equal(jarKey("localhost"), "localhost");
  assert.equal(jarKey("192.0.2.1"), "192.0.2.1");
});

test("jarFor returns a stable jar per (sid, eTLD+1)", () => {
  const j1 = jarFor("sid-3", "www.example.com");
  const j2 = jarFor("sid-3", "api.example.com");
  assert.equal(j1, j2, "same registrable domain must share a jar");
  dropSession("sid-3");
});
