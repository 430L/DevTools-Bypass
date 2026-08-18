"use strict";

const { WebSocketServer, WebSocket } = require("ws");
const { decodeTarget } = require("../rewrite/url");
const { validateTarget } = require("../security/ssrf");
const { isAuthed } = require("../security/auth");
const { logger, safeUrl } = require("../logger");
const config = require("../config");

const WS_PREFIX = "/api/ws/";
const MAX_CONNECTIONS_PER_SESSION = 32;
const activeBySession = new Map();

function attach(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  httpServer.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith(WS_PREFIX)) return abort(socket, 404);
    if (!isAuthed(req)) return abort(socket, 401);

    const encoded = req.url.split("?", 1)[0].slice(WS_PREFIX.length);
    const decoded = decodeTarget(encoded);
    if (!decoded) return abort(socket, 400);

    let target;
    try {
      target = new URL(decoded);
    } catch {
      return abort(socket, 400);
    }
    if (!["ws:", "wss:", "http:", "https:"].includes(target.protocol)) return abort(socket, 400);
    // Normalize to WS scheme (target may have been advertised over http/https).
    if (target.protocol === "http:") target.protocol = "ws:";
    if (target.protocol === "https:") target.protocol = "wss:";

    validateTarget(new URL(target.href.replace(/^ws/, "http")))
      .then(() => {
        wss.handleUpgrade(req, socket, head, (client) => bridge(req, client, target));
      })
      .catch((err) => {
        logger.warn({ err: err.message }, "WebSocket target rejected");
        abort(socket, 403);
      });
  });

  return wss;
}

function bridge(req, client, target) {
  const sid = extractSid(req.headers.cookie || "");
  const bucket = activeBySession.get(sid) || 0;
  if (bucket >= MAX_CONNECTIONS_PER_SESSION) {
    client.close(1013, "Too many connections");
    return;
  }
  activeBySession.set(sid, bucket + 1);
  let released = false;
  const releaseBucket = () => {
    if (released) return;
    released = true;
    const left = (activeBySession.get(sid) || 1) - 1;
    if (left <= 0) activeBySession.delete(sid);
    else activeBySession.set(sid, left);
  };

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.cookie; // upstream sees its own cookies via a future jar hook if wired
  delete headers.connection;
  delete headers.upgrade;
  delete headers["sec-websocket-key"];
  delete headers["sec-websocket-version"];
  delete headers["sec-websocket-extensions"];

  // ws.WebSocket can throw synchronously on bad URLs / invalid option shapes. Without
  // the try/catch below the bucket counter would leak until process restart, and 32
  // failed connections would permanently lock the session out.
  let upstream;
  try {
    upstream = new WebSocket(target.href, {
      headers,
      perMessageDeflate: false,
      handshakeTimeout: config.REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    releaseBucket();
    logger.warn({ err: err.message, target: safeUrl(target) }, "WS constructor threw");
    try {
      client.close(1011, "Upstream construction failed");
    } catch {
      /* noop */
    }
    return;
  }

  const close = () => {
    releaseBucket();
    try {
      client.close();
    } catch {
      /* noop */
    }
    try {
      upstream.close();
    } catch {
      /* noop */
    }
  };

  upstream.on("open", () => {
    upstream.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
    client.on("message", (data, isBinary) => upstream.send(data, { binary: isBinary }));
  });
  upstream.on("close", close);
  upstream.on("error", (err) => {
    logger.warn({ err: err.message, target: safeUrl(target) }, "WS upstream error");
    close();
  });
  client.on("close", close);
  client.on("error", close);
}

function extractSid(cookieHeader) {
  const m = /(?:^|;\s*)insite_session=([^;]+)/.exec(cookieHeader);
  return m ? m[1] : "";
}

function abort(socket, status) {
  try {
    socket.write(`HTTP/1.1 ${status} ${statusText(status)}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* noop */
  }
  try {
    socket.destroy();
  } catch {
    /* noop */
  }
}

function statusText(s) {
  return (
    { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" }[s] || "Error"
  );
}

module.exports = { attach, WS_PREFIX };
