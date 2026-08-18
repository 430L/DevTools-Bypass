"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { jarFor, storeSetCookies, getCookieHeader, dropSession } = require("../src/proxy/cookies");

test("cookies are scoped per session per target origin", async () => {
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

test("cookies for one origin do not leak to another", async () => {
  await storeSetCookies("sid-1", new URL("https://alpha.example.com/"), ["s=alpha; Path=/"]);
  await storeSetCookies("sid-1", new URL("https://beta.example.com/"), ["s=beta; Path=/"]);
  const alpha = await getCookieHeader("sid-1", new URL("https://alpha.example.com/"));
  const beta = await getCookieHeader("sid-1", new URL("https://beta.example.com/"));
  assert.match(alpha, /s=alpha/);
  assert.equal(alpha.includes("beta"), false);
  assert.match(beta, /s=beta/);
  dropSession("sid-1");
});

test("jarFor returns a stable jar per (sid, origin)", () => {
  const j1 = jarFor("sid-3", "https://example.com");
  const j2 = jarFor("sid-3", "https://example.com");
  assert.equal(j1, j2);
  dropSession("sid-3");
});
