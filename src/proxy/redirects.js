"use strict";

const { cleanTarget, proxyEndpoint } = require("../rewrite/url");

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// If the upstream returned a 3xx redirect, rewrite its Location to point at the proxy
// (so the browser fetches the next hop through us) and forward the same status verbatim.
// Returns true if handled, false otherwise.
function handleRedirect(upstream, target, res) {
  if (!REDIRECT_CODES.has(upstream.status)) return false;
  const loc = upstream.headers.get("location");
  if (!loc) {
    res.status(upstream.status).end();
    return true;
  }
  const resolved = cleanTarget(loc, target.href);
  if (!resolved) {
    res.status(502).json({ error: "Upstream redirect target is not HTTP(S)." });
    return true;
  }
  res.setHeader("Location", proxyEndpoint(resolved, "page"));
  res.status(upstream.status).end();
  return true;
}

module.exports = { handleRedirect, REDIRECT_CODES };
