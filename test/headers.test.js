"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { copyResponseHeaders, REQUEST_DENY, RESPONSE_DENY } = require("../src/proxy/headers");

function mockRes() {
  const set = {};
  return {
    setHeader(k, v) {
      // Mimic Node's validation so the test exercises the real failure mode.
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k)) {
        const e = new TypeError(`Invalid header token: ${k}`);
        e.code = "ERR_INVALID_HTTP_TOKEN";
        throw e;
      }
      if (/[\r\n]/.test(String(v))) {
        const e = new TypeError("Invalid character in header content");
        e.code = "ERR_INVALID_CHAR";
        throw e;
      }
      set[k] = v;
    },
    _set: set,
  };
}

test("a malformed upstream header does not break the whole response", () => {
  const res = mockRes();
  assert.doesNotThrow(() =>
    copyResponseHeaders(
      {
        "content-type": "text/html",
        "bad header name": "x",
        "x-newline": "line1\r\nInjected: yes",
        "x-good": "kept",
      },
      res,
    ),
  );
  assert.equal(res._set["content-type"], "text/html");
  assert.equal(res._set["x-good"], "kept");
  assert.equal(res._set["bad header name"], undefined);
  assert.equal(res._set["x-newline"], undefined);
});

test("security headers from the target are stripped", () => {
  const res = mockRes();
  copyResponseHeaders(
    {
      "content-security-policy": "default-src 'none'",
      "x-frame-options": "DENY",
      "strict-transport-security": "max-age=31536000",
      "set-cookie": "a=1",
      "content-type": "text/html",
    },
    res,
  );
  assert.equal(res._set["content-security-policy"], undefined);
  assert.equal(res._set["x-frame-options"], undefined);
  assert.equal(res._set["strict-transport-security"], undefined);
  assert.equal(res._set["set-cookie"], undefined);
  assert.equal(res._set["content-type"], "text/html");
});

test("cache headers are only forwarded for subresources", () => {
  const page = mockRes();
  copyResponseHeaders({ "cache-control": "max-age=60", etag: "W/x" }, page, {
    forwardCache: false,
  });
  assert.equal(page._set["cache-control"], undefined);
  assert.equal(page._set.etag, undefined);

  const asset = mockRes();
  copyResponseHeaders({ "cache-control": "max-age=60", etag: "W/x" }, asset, {
    forwardCache: true,
  });
  assert.equal(asset._set["cache-control"], "max-age=60");
  assert.equal(asset._set.etag, "W/x");
});

test("client credentials are never forwarded upstream", () => {
  for (const h of ["cookie", "authorization", "proxy-authorization"]) {
    assert.ok(REQUEST_DENY.has(h), `${h} must be in the request denylist`);
  }
});

test("hop-by-hop and policy headers are in the response denylist", () => {
  for (const h of ["set-cookie", "content-encoding", "transfer-encoding", "permissions-policy"]) {
    assert.ok(RESPONSE_DENY.has(h), `${h} must be in the response denylist`);
  }
});
