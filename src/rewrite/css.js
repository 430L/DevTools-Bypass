"use strict";

const { cleanTarget, proxyEndpoint, isNonHttp } = require("./url");

// Rewrite every URL in a CSS string. Handles:
//   url(...), url("..."), url('...')
//   @import "...", @import '...', @import url(...)
//   image-set(url(...)), cursor: url(...), etc. — anything that uses url(...).
// Quoted URLs may contain escaped quotes (\\") and parentheses.
function rewriteCss(css, base) {
  if (!css) return css;
  let out = "";
  let i = 0;
  const n = css.length;

  while (i < n) {
    // Fast path: consume until the next `url(` or `@import`.
    const nextUrl = css.indexOf("url(", i);
    const nextImport = css.indexOf("@import", i);
    let next = -1;
    if (nextUrl === -1 && nextImport === -1) {
      out += css.slice(i);
      break;
    }
    if (nextUrl === -1) next = nextImport;
    else if (nextImport === -1) next = nextUrl;
    else next = Math.min(nextUrl, nextImport);

    out += css.slice(i, next);

    if (next === nextUrl) {
      const parsed = readUrlFunction(css, next);
      if (parsed) {
        const rewritten = rewriteMaybe(parsed.url, base);
        out += `url(${parsed.quote}${rewritten}${parsed.quote})`;
        i = parsed.end;
      } else {
        out += css[next];
        i = next + 1;
      }
    } else {
      // @import <url-or-string> [layer|supports|media]?
      const parsed = readImport(css, next);
      if (parsed) {
        const rewritten = rewriteMaybe(parsed.url, base);
        out += `@import ${parsed.quote}${rewritten}${parsed.quote}${parsed.tail}`;
        i = parsed.end;
      } else {
        out += css[next];
        i = next + 1;
      }
    }
  }

  return out;
}

function rewriteMaybe(raw, base) {
  if (isNonHttp(raw)) return raw;
  const u = cleanTarget(raw, base);
  return u ? proxyEndpoint(u, "resource") : raw;
}

function readUrlFunction(css, start) {
  let i = start + 4; // past "url("
  // Skip whitespace.
  while (i < css.length && /\s/.test(css[i])) i++;
  let quote = "";
  let value = "";
  if (css[i] === '"' || css[i] === "'") {
    quote = css[i];
    i++;
    while (i < css.length) {
      const c = css[i];
      if (c === "\\" && i + 1 < css.length) {
        value += c + css[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) {
        i++;
        break;
      }
      value += c;
      i++;
    }
  } else {
    // Unquoted URL: read until whitespace or closing paren.
    while (i < css.length && !/[\s)]/.test(css[i])) {
      value += css[i];
      i++;
    }
  }
  while (i < css.length && /\s/.test(css[i])) i++;
  if (css[i] !== ")") return null;
  return { url: value, quote, end: i + 1 };
}

function readImport(css, start) {
  let i = start + 7; // past "@import"
  while (i < css.length && /\s/.test(css[i])) i++;
  if (css.startsWith("url(", i)) {
    const u = readUrlFunction(css, i);
    if (!u) return null;
    // Preserve everything up to the next `;` or newline.
    const semi = findStatementEnd(css, u.end);
    return { url: u.url, quote: u.quote || '"', tail: css.slice(u.end, semi), end: semi };
  }
  const c = css[i];
  if (c !== '"' && c !== "'") return null;
  let value = "";
  const quote = c;
  i++;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "\\" && i + 1 < css.length) {
      value += ch + css[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) {
      i++;
      break;
    }
    value += ch;
    i++;
  }
  const semi = findStatementEnd(css, i);
  return { url: value, quote, tail: css.slice(i, semi), end: semi };
}

function findStatementEnd(css, from) {
  for (let i = from; i < css.length; i++) {
    if (css[i] === ";" || css[i] === "\n") return i;
  }
  return css.length;
}

module.exports = { rewriteCss };
