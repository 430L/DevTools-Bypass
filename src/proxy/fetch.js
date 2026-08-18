"use strict";

const { fetch, Agent } = require("undici");
const { validateTarget, pinnedAgent } = require("../security/ssrf");
const { buildRequestHeaders } = require("./headers");
const { getCookieHeader } = require("./cookies");
const config = require("../config");

// Fallback shared agent for non-pinned use.
const defaultAgent = new Agent();

// Perform the upstream fetch. `body` is a Buffer or null; content-type is preserved by
// the copied request headers.
//
// Returns { response, cleanup }. cleanup MUST be called by the caller once the response
// body has been consumed / piped / cancelled — it clears the abort timer. The undici Agent
// itself is a shared cache entry (ssrf.pinnedAgent) so we never close it per-request.
async function fetchUpstream({ target, req, sid, body }) {
  const { pinned } = await validateTarget(target);
  const dispatcher = pinnedAgent(pinned);
  const headers = buildRequestHeaders(req);
  const cookieHeader = await getCookieHeader(sid, target);
  if (cookieHeader) headers.cookie = cookieHeader;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
  const cleanup = () => clearTimeout(timer);

  try {
    const init = {
      method: (req.method || "GET").toUpperCase(),
      headers,
      redirect: "manual",
      signal: controller.signal,
      dispatcher,
    };
    if (body != null && ["POST", "PUT", "PATCH", "DELETE"].includes(init.method)) {
      init.body = body;
    }
    const response = await fetch(target.href, init);
    return { response, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

module.exports = { fetchUpstream, defaultAgent };
