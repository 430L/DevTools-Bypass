"use strict";

const { fetch, Agent } = require("undici");
const { validateTarget, pinnedAgent } = require("../security/ssrf");
const { buildRequestHeaders } = require("./headers");
const { getCookieHeader } = require("./cookies");
const config = require("../config");

// Default agent for non-pinned use (e.g. eruda vendor asset). Real proxied requests each
// build their own pinned agent from ssrf.pinnedAgent so DNS rebinding is impossible.
const defaultAgent = new Agent();

// Perform the upstream fetch. `body` is a Buffer or null; content-type is preserved by
// the copied request headers. Returns the raw undici Response so the caller can stream it.
async function fetchUpstream({ target, req, sid, body }) {
  const { pinned } = await validateTarget(target);
  const dispatcher = pinnedAgent(pinned);
  const headers = buildRequestHeaders(req);
  const cookieHeader = await getCookieHeader(sid, target);
  if (cookieHeader) headers.cookie = cookieHeader;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);

  try {
    const init = {
      method: req.method || "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
      dispatcher,
    };
    const method = init.method.toUpperCase();
    if (body != null && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      init.body = body;
      init.duplex = "half";
    }
    return await fetch(target.href, init);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchUpstream, defaultAgent };
