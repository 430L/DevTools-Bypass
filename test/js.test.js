"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rewriteJs } = require("../src/rewrite/js");

const BASE = "https://example.com/app.js";

test("static import specifier is rewritten", () => {
  const out = rewriteJs('import x from "./util.js";', BASE);
  assert.match(out, /import x from "\/api\/resource\/[A-Za-z0-9_-]+"/);
});

test("dynamic import specifier is rewritten", () => {
  const out = rewriteJs('const p = import("./lazy.js");', BASE);
  assert.match(out, /import\("\/api\/resource\/[A-Za-z0-9_-]+"\)/);
});

test("export ... from is rewritten", () => {
  const out = rewriteJs('export { default } from "./mod.js";', BASE);
  assert.match(out, /from "\/api\/resource\/[A-Za-z0-9_-]+"/);
});

test("new URL(specifier, import.meta.url) is rewritten", () => {
  const out = rewriteJs('const u = new URL("./worker.js", import.meta.url);', BASE);
  assert.match(out, /new URL\("\/api\/resource\/[A-Za-z0-9_-]+", import\.meta\.url\)/);
});

test("new Worker(specifier) is rewritten", () => {
  const out = rewriteJs('new Worker("./w.js");', BASE);
  assert.match(out, /new Worker\("\/api\/resource\//);
});

test("String literals in comments are NOT rewritten (AST-safe)", () => {
  const src = '// import "./nope.js";\nconst x = 1;';
  const out = rewriteJs(src, BASE);
  assert.equal(out.includes("/api/resource/"), false);
});

test("data: import specifiers pass through", () => {
  const src = 'import x from "data:text/javascript,console.log(1)";';
  const out = rewriteJs(src, BASE);
  assert.equal(out, src);
});

test("Unparseable source is returned verbatim (no corruption)", () => {
  const src = "!!!not valid javascript !!!";
  assert.equal(rewriteJs(src, BASE), src);
});
