"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { handleRedirect } = require("../src/proxy/redirects");

function mockRes() {
  const headers = {};
  let status = 200;
  let body = null;
  return {
    setHeader(k, v) {
      headers[k] = v;
    },
    status(s) {
      status = s;
      return this;
    },
    end() {
      body = "";
      return this;
    },
    json(o) {
      body = JSON.stringify(o);
      return this;
    },
    _get: () => ({ status, headers, body }),
  };
}

function mockUpstream(status, location) {
  return { status, headers: { get: (k) => (k === "location" ? location : null) } };
}

const TARGET = new URL("https://example.com/orig");

test("301 with absolute Location is rewritten and same status forwarded", () => {
  const res = mockRes();
  const handled = handleRedirect(mockUpstream(301, "https://new.example.com/next"), TARGET, res);
  assert.equal(handled, true);
  const { status, headers } = res._get();
  assert.equal(status, 301);
  assert.match(headers.Location, /^\/api\/page\/[A-Za-z0-9_-]+$/);
});

test("302 with relative Location resolves against the target", () => {
  const res = mockRes();
  handleRedirect(mockUpstream(302, "/nested"), TARGET, res);
  const { status, headers } = res._get();
  assert.equal(status, 302);
  assert.match(headers.Location, /^\/api\/page\/[A-Za-z0-9_-]+$/);
});

test("303 (POST → GET semantics) is forwarded as 303", () => {
  const res = mockRes();
  handleRedirect(mockUpstream(303, "https://example.com/get-me"), TARGET, res);
  assert.equal(res._get().status, 303);
});

test("307/308 preserve their status", () => {
  const r307 = mockRes();
  const r308 = mockRes();
  handleRedirect(mockUpstream(307, "https://example.com/a"), TARGET, r307);
  handleRedirect(mockUpstream(308, "https://example.com/b"), TARGET, r308);
  assert.equal(r307._get().status, 307);
  assert.equal(r308._get().status, 308);
});

test("Non-HTTP Location returns 502 (blocks javascript:/data:)", () => {
  const res = mockRes();
  handleRedirect(mockUpstream(302, "javascript:alert(1)"), TARGET, res);
  assert.equal(res._get().status, 502);
});

test("Non-3xx response is left alone", () => {
  const res = mockRes();
  const handled = handleRedirect({ status: 200, headers: { get: () => null } }, TARGET, res);
  assert.equal(handled, false);
});

test("resource redirects rewrite to /api/resource/, not /api/page/", () => {
  // Regression: a 302 from an image CDN must not turn the browser onto the HTML pipeline
  // (which would inject Eruda into the JPEG slot).
  const res = mockRes();
  handleRedirect(mockUpstream(302, "https://cdn.example.com/x.jpg"), TARGET, res, "resource");
  const { headers } = res._get();
  assert.match(headers.Location, /^\/api\/resource\/[A-Za-z0-9_-]+$/);
});

test("page redirects still use /api/page/ when kind is omitted", () => {
  const res = mockRes();
  handleRedirect(mockUpstream(302, "https://example.com/next"), TARGET, res);
  assert.match(res._get().headers.Location, /^\/api\/page\/[A-Za-z0-9_-]+$/);
});
