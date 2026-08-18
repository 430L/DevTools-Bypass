"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rewriteHtml, rewriteMetaRefresh } = require("../src/rewrite/html");

const TARGET = new URL("https://example.com/page/");

test("script src is rewritten to /api/resource/", () => {
  const out = rewriteHtml('<html><head><script src="/x.js"></script></head></html>', TARGET);
  assert.match(out, /script src="\/api\/resource\/[A-Za-z0-9_-]+"/);
});

test("link rel=stylesheet href is rewritten", () => {
  const out = rewriteHtml(
    '<html><head><link rel="stylesheet" href="/x.css"></head></html>',
    TARGET,
  );
  assert.match(out, /href="\/api\/resource\/[A-Za-z0-9_-]+"/);
});

test("link rel=icon and manifest are rewritten", () => {
  const out = rewriteHtml(
    '<html><head><link rel="icon" href="/f.ico"><link rel="manifest" href="/m.json"></head></html>',
    TARGET,
  );
  const count = (out.match(/\/api\/resource\//g) || []).length;
  assert.equal(count, 2);
});

test("iframe src is rewritten to /api/page/", () => {
  const out = rewriteHtml(
    '<html><body><iframe src="https://other.com/x"></iframe></body></html>',
    TARGET,
  );
  assert.match(out, /iframe src="\/api\/page\/[A-Za-z0-9_-]+"/);
});

test("integrity attribute is stripped", () => {
  const out = rewriteHtml(
    '<html><head><script src="/x.js" integrity="sha384-abc"></script></head></html>',
    TARGET,
  );
  assert.equal(out.includes("integrity"), false);
});

test("base tag is removed", () => {
  const out = rewriteHtml('<html><head><base href="https://other.com/"></head></html>', TARGET);
  assert.equal(out.includes("<base"), false);
});

test("anchor hrefs are absolutized against the target URL (kills about:srcdoc)", () => {
  const out = rewriteHtml(
    '<html><body><a href="/foo">x</a><a href="bar">y</a></body></html>',
    TARGET,
  );
  assert.match(out, /<a href="https:\/\/example\.com\/foo">/);
  assert.match(out, /<a href="https:\/\/example\.com\/page\/bar">/);
});

test("meta http-equiv=refresh is rewritten through the proxy", () => {
  const out = rewriteHtml(
    '<html><head><meta http-equiv="refresh" content="0; url=/next"></head></html>',
    TARGET,
  );
  assert.match(out, /url=\/api\/page\/[A-Za-z0-9_-]+/);
});

test("rewriteMetaRefresh handles quoted URL", () => {
  const out = rewriteMetaRefresh('2; url="/next"', "https://example.com/");
  assert.match(out, /url=\/api\/page\/[A-Za-z0-9_-]+/);
});

test("srcset in <img> is rewritten", () => {
  const out = rewriteHtml('<img srcset="/a.png 1x, /b.png 2x">', TARGET);
  assert.match(out, /\/api\/resource\/[A-Za-z0-9_-]+ 1x/);
  assert.match(out, /\/api\/resource\/[A-Za-z0-9_-]+ 2x/);
});

test("iframe srcdoc is recursively rewritten", () => {
  const out = rewriteHtml("<iframe srcdoc='<script src=\"/x.js\"></script>'></iframe>", TARGET);
  // The srcdoc attribute value gets HTML-attribute-encoded, but the rewritten resource path
  // remains literal (no need to encode `/` or `:`), so we just look for it anywhere in the
  // srcdoc attribute payload.
  const m = /srcdoc="([^"]*)"/.exec(out);
  assert.ok(m, "iframe must have a srcdoc attribute");
  assert.match(m[1], /\/api\/resource\//);
});

test("importmap specifiers are rewritten", () => {
  const html = `<script type="importmap">{"imports":{"lodash":"https://cdn.example.com/lodash.js"}}</script>`;
  const out = rewriteHtml(html, TARGET);
  assert.match(out, /"lodash":"\/api\/resource\/[A-Za-z0-9_-]+"/);
});

test("CSP meta tag is dropped", () => {
  const out = rewriteHtml(
    '<html><head><meta http-equiv="content-security-policy" content="default-src none"></head></html>',
    TARGET,
  );
  assert.equal(out.toLowerCase().includes("content-security-policy"), false);
});

test("target=_top on anchors becomes _self", () => {
  const out = rewriteHtml('<a href="/x" target="_top">x</a>', TARGET);
  assert.match(out, /target="_self"/);
});

test("Boot script escapes </ sequences in the JSON payload", () => {
  const t = new URL("https://example.com/</script><script>alert(1)</script>/");
  const out = rewriteHtml("<html><head></head></html>", t);
  // No un-escaped </script> in the boot payload.
  const firstScript = out.indexOf("window.__INSITE__=");
  const scriptTail = out.indexOf("</script>", firstScript);
  const injected = out.slice(firstScript, scriptTail);
  assert.equal(/<\/script/i.test(injected.replace(/\\u003c\/script/i, "")), false);
});
