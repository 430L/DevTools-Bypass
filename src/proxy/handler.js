"use strict";

const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { decodeTarget } = require("../rewrite/url");
const { rewriteHtml } = require("../rewrite/html");
const { rewriteCss } = require("../rewrite/css");
const { rewriteJs } = require("../rewrite/js");
const { fetchUpstream } = require("./fetch");
const { copyResponseHeaders } = require("./headers");
const { storeSetCookies, extractSetCookies } = require("./cookies");
const { handleRedirect } = require("./redirects");
const { limitedTransform, collectBounded, BodySizeLimitError } = require("../util/streams");
const { escapeHtml } = require("../util/html-escape");
const { readSessionId } = require("../security/auth");
const { logger, safeUrl } = require("../logger");
const config = require("../config");

function extractEncoded(originalUrl, prefix) {
  const path = originalUrl.split("?", 1)[0];
  return path.startsWith(prefix) ? path.slice(prefix.length) : "";
}

function needsRewrite(kind, contentType, pathname) {
  const ct = contentType.toLowerCase();
  if (kind === "page" || ct.includes("text/html")) return "html";
  if (ct.includes("text/css") || /\.css(?:$|\?)/i.test(pathname)) return "css";
  if (
    ct.includes("javascript") ||
    ct.includes("ecmascript") ||
    /\.(?:m?js)(?:$|\?)/i.test(pathname)
  )
    return "js";
  return null;
}

async function handleProxy(req, res, kind) {
  const prefix = `/api/${kind}/`;
  const encoded = extractEncoded(req.originalUrl, prefix);
  if (!encoded) return res.status(400).json({ error: "Missing encoded target URL." });

  const decoded = decodeTarget(encoded);
  if (!decoded) return res.status(400).json({ error: "Invalid target encoding." });

  let target;
  try {
    target = new URL(decoded);
  } catch {
    return res.status(400).json({ error: "Invalid target URL." });
  }
  target.username = "";
  target.password = "";

  const sid = readSessionId(req);

  let fetched;
  try {
    fetched = await fetchUpstream({
      target,
      req,
      sid,
      body: Buffer.isBuffer(req.body) && req.body.length ? req.body : null,
    });
  } catch (err) {
    return sendUpstreamError(res, target, err);
  }

  const { response: upstream, cleanup } = fetched;

  try {
    // Store any Set-Cookie into the per-session jar; never re-emit to the browser.
    const setCookies = extractSetCookies(upstream.headers);
    if (setCookies.length) {
      try {
        await storeSetCookies(sid, target, setCookies);
      } catch {
        /* jar issues are non-fatal */
      }
    }

    if (handleRedirect(upstream, target, res)) return;

    const contentType = upstream.headers.get("content-type") || "";
    const responseHeaders = Object.fromEntries(upstream.headers.entries());
    copyResponseHeaders(responseHeaders, res, { forwardCache: kind === "resource" });
    if (kind === "page") res.setHeader("cache-control", "no-store");

    // 204/304/HEAD responses carry no body — send status and stop.
    if (
      upstream.body == null ||
      upstream.status === 204 ||
      upstream.status === 304 ||
      req.method === "HEAD"
    ) {
      return res.status(upstream.status).end();
    }

    const rewriteMode = needsRewrite(kind, contentType, target.pathname);
    const bodyStream = Readable.fromWeb(upstream.body);

    if (rewriteMode) {
      let buf;
      try {
        buf = await collectBounded(bodyStream, config.MAX_RESPONSE_BYTES);
      } catch (err) {
        return sendUpstreamError(res, target, err);
      }
      const text = buf.toString("utf8");
      let out = text;
      if (rewriteMode === "html") {
        out = rewriteHtml(text, target);
        res.type("html");
      } else if (rewriteMode === "css") {
        out = rewriteCss(text, target.href);
        res.type("css");
      } else if (rewriteMode === "js") {
        try {
          out = rewriteJs(text, target.href);
        } catch (err) {
          logger.warn(
            { target: safeUrl(target), err: err?.message },
            "JS rewrite failed; passing through",
          );
          out = text;
        }
        res.type("application/javascript");
      }
      return res.status(upstream.status).send(out);
    }

    res.status(upstream.status);
    try {
      await pipeline(bodyStream, limitedTransform(config.MAX_RESPONSE_BYTES), res);
    } catch (err) {
      if (err instanceof BodySizeLimitError && !res.headersSent) {
        return res.status(413).send("Upstream response exceeds configured size.");
      }
      if (!res.headersSent) return sendUpstreamError(res, target, err);
      logger.warn({ target: safeUrl(target), err: err?.message }, "Streaming aborted mid-response");
      res.destroy();
    }
  } finally {
    cleanup();
  }
}

function sendUpstreamError(res, target, err) {
  const isAbort = err?.name === "AbortError";
  const isSize = err instanceof BodySizeLimitError;
  const status = isSize ? 413 : 502;
  const message = isAbort
    ? "Upstream request timed out."
    : isSize
      ? "Upstream response exceeds configured size."
      : "Upstream request failed.";
  logger.warn({ target: safeUrl(target), err: err?.message }, "Upstream error");
  if (res.headersSent) {
    res.destroy();
    return;
  }
  return res
    .status(status)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><title>InSite Proxy Error</title>` +
        `<style>body{font:15px system-ui;background:#0b1020;color:#e5e7eb;padding:30px}` +
        `pre{white-space:pre-wrap;background:#111827;padding:14px;border:1px solid #334155;border-radius:8px}` +
        `a{color:#60a5fa}</style>` +
        `<h1>InSite Proxy Error</h1>` +
        `<p>Target: ${escapeHtml(safeUrl(target))}</p>` +
        `<pre>${escapeHtml(message)}</pre>` +
        `<p><a href="/">Return to InSite</a></p>`,
    );
}

module.exports = { handleProxy };
