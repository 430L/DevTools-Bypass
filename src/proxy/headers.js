"use strict";

// Headers we NEVER copy from the client's inbound request onto the outbound upstream fetch.
// - hop-by-hop headers, per RFC 7230 §6.1
// - cookie/authorization: forwarded via the per-target cookie jar, not the browser's cookie header
// - origin/referer: proxy identity, not target's
// - if-modified-since / if-none-match: we manage our own caching, forwarding these would defeat rewrites
// - accept-encoding: undici negotiates; a text body we intend to rewrite must be decoded first
const REQUEST_DENY = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "origin",
  "referer",
  "cookie",
  "authorization",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "keep-alive",
  "upgrade",
  "if-modified-since",
  "if-none-match",
  "if-match",
  "if-range",
  "if-unmodified-since",
  "expect",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

// Headers we NEVER copy from the upstream response back to the client.
// - CSP/XFO/COOP/COEP/CORP: the shell embeds pages in a same-origin iframe; keeping these breaks it
// - HSTS/pin/expect-ct: would pin/lock the shell's own hostname
// - permissions-policy/referrer-policy: target's opinions bleed into the shell
// - set-cookie: consumed by the server-side cookie jar, never re-emitted to the browser
// - content-length/-encoding/transfer-encoding: our stream length differs after rewriting
const RESPONSE_DENY = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "set-cookie",
  "strict-transport-security",
  "public-key-pins",
  "public-key-pins-report-only",
  "expect-ct",
  "clear-site-data",
  "permissions-policy",
  "referrer-policy",
  "x-download-options",
  "x-permitted-cross-domain-policies",
  "alt-svc",
  "origin-agent-cluster",
  "x-content-type-options",
  "server-timing",
  "connection",
  "keep-alive",
  "upgrade",
]);

function buildRequestHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (REQUEST_DENY.has(key)) continue;
    if (typeof v !== "string") continue;
    out[key] = v;
  }
  // Reasonable default UA if the client did not send one (rare, but happens for scripted callers).
  if (!out["user-agent"]) out["user-agent"] = "Mozilla/5.0 InSiteProxy";
  return out;
}

function copyResponseHeaders(upstreamHeaders, res, { forwardCache = false } = {}) {
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const key = name.toLowerCase();
    if (RESPONSE_DENY.has(key)) continue;
    if (
      !forwardCache &&
      (key === "cache-control" || key === "etag" || key === "last-modified" || key === "expires")
    ) {
      continue;
    }
    // A malformed upstream header name/value makes Node throw ERR_INVALID_HTTP_TOKEN /
    // ERR_INVALID_CHAR. One bad header from one site must not fail the whole response.
    try {
      res.setHeader(name, value);
    } catch {
      /* skip the offending header and keep going */
    }
  }
}

module.exports = { buildRequestHeaders, copyResponseHeaders, REQUEST_DENY, RESPONSE_DENY };
