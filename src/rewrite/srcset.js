"use strict";

const { cleanTarget, proxyEndpoint, isNonHttp } = require("./url");

// Split a srcset attribute at top-level commas — commas inside parentheses
// (a `data:image/svg+xml,<svg viewBox="0,0,10,10"/>` URI is legal here) are ignored.
function splitTopLevel(raw) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  out.push(raw.slice(start));
  return out;
}

function rewriteSrcset(raw, base) {
  if (!raw) return raw;
  return splitTopLevel(raw)
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      // Descriptor (` 2x`, ` 320w`) is everything after the first run of whitespace.
      const m = trimmed.match(/^(\S+)(\s+.*)?$/);
      if (!m) return part;
      const url = m[1];
      const rest = m[2] || "";
      if (isNonHttp(url)) return `${url}${rest}`;
      const u = cleanTarget(url, base);
      return `${u ? proxyEndpoint(u, "resource") : url}${rest}`;
    })
    .join(", ");
}

module.exports = { rewriteSrcset, splitTopLevel };
