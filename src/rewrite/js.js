"use strict";

const MagicString = require("magic-string");
const { parse } = require("meriyah");
const { cleanTarget, proxyEndpoint } = require("./url");

const MAX_JS_BYTES = 4 * 1024 * 1024;

// Rewrite ES module specifiers so they hit the resource proxy. Falls back to
// returning the source unchanged when the file is too large or fails to parse
// (avoids corrupting minified bundles).
function rewriteJs(src, base) {
  if (!src) return src;
  if (Buffer.byteLength(src, "utf8") > MAX_JS_BYTES) return src;

  let ast;
  try {
    ast = parse(src, {
      module: true,
      next: true,
      jsx: false,
      loc: false,
      ranges: true,
      webcompat: true,
    });
  } catch {
    // Not valid ESM (may be classic script). Try a classic-script parse; if that
    // fails, leave the file alone — better shipped verbatim than corrupted.
    try {
      ast = parse(src, { module: false, next: true, ranges: true, webcompat: true });
    } catch {
      return src;
    }
  }

  const s = new MagicString(src);
  const seen = new WeakSet();

  walk(ast, (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);

    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      (node.type === "ExportNamedDeclaration" && node.source)
    ) {
      replaceStringLiteral(s, node.source, base);
    } else if (node.type === "ImportExpression" && node.source?.type === "Literal") {
      replaceStringLiteral(s, node.source, base);
    } else if (isNewUrlImportMeta(node)) {
      // new URL("./x", import.meta.url) → rewrite the first argument.
      replaceStringLiteral(s, node.arguments[0], base);
    } else if (isWorkerConstruction(node)) {
      replaceStringLiteral(s, node.arguments[0], base);
    }
  });

  return s.toString();
}

function replaceStringLiteral(s, node, base) {
  if (!node || node.type !== "Literal" || typeof node.value !== "string") return;
  const u = cleanTarget(node.value, base);
  if (!u) return;
  const replacement = JSON.stringify(proxyEndpoint(u, "resource"));
  s.overwrite(node.range[0], node.range[1], replacement);
}

function isNewUrlImportMeta(node) {
  if (node?.type !== "NewExpression") return false;
  if (node.callee?.type !== "Identifier" || node.callee.name !== "URL") return false;
  const [first, second] = node.arguments || [];
  if (first?.type !== "Literal" || typeof first.value !== "string") return false;
  // Second arg is `import.meta.url` — detect the shape.
  if (!second) return false;
  return (
    second.type === "MemberExpression" &&
    second.property?.name === "url" &&
    second.object?.type === "MetaProperty" &&
    second.object.meta?.name === "import" &&
    second.object.property?.name === "meta"
  );
}

function isWorkerConstruction(node) {
  if (node?.type !== "NewExpression") return false;
  const name = node.callee?.type === "Identifier" ? node.callee.name : "";
  if (name !== "Worker" && name !== "SharedWorker") return false;
  const first = node.arguments?.[0];
  return first?.type === "Literal" && typeof first.value === "string";
}

// Depth-first AST walk. Handles arbitrary nested objects/arrays; skips loc/range/tokens.
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end" || key === "parent")
      continue;
    const val = node[key];
    if (val && typeof val === "object") walk(val, visit);
  }
}

module.exports = { rewriteJs };
