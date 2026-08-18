"use strict";

// Crash guards. The distinction between boot-phase and runtime failures matters:
//
//   * Before the port is bound, an uncaught error means the app can never serve anything.
//     Exiting non-zero makes the platform restart us and surfaces a real crash in its UI.
//     (Swallowing it produced a *clean* exit 0 with no listener, which reaches users as
//     an unexplained Cloudflare 502.)
//   * After we are listening, a stray rejection from one request must not take down the
//     whole server — log it and keep serving everyone else.
let listening = false;

function onFatal(kind, err) {
  const detail = err?.stack || String(err);
  if (!listening) {
    console.error(
      `\n[InSite] FATAL during startup (${kind}):\n${detail}\n` +
        "[InSite] The server never bound a port, so all requests will fail at the edge.\n",
    );
    process.exit(1);
  }
  console.error(`[InSite] ${kind} (server still running):`, detail);
}

process.on("uncaughtException", (err) => onFatal("uncaughtException", err));
process.on("unhandledRejection", (err) => onFatal("unhandledRejection", err));

const http = require("node:http");
const path = require("node:path");
const express = require("express");
const compression = require("compression");
const helmet = require("helmet");

const config = require("./config");
const { logger } = require("./logger");
const auth = require("./security/auth");
const { createLimiter } = require("./security/rate-limit");
const { handleProxy } = require("./proxy/handler");
const ws = require("./proxy/websocket");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// Prefer the browser UMD bundle explicitly; require.resolve("eruda") honors `main`, which
// is correct today but not guaranteed across upgrades. Neither failing is worth crashing
// over — the shell still works without the injected devtools.
let ERUDA_PATH = null;
for (const spec of ["eruda/eruda.js", "eruda"]) {
  try {
    ERUDA_PATH = require.resolve(spec);
    break;
  } catch {
    /* try the next specifier */
  }
}
if (!ERUDA_PATH) {
  config.warnings.push("eruda could not be resolved — /vendor/eruda.js will return 404");
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.TRUST_PROXY_HOPS);

// Middleware that must NOT touch proxied bodies. `srcdoc` iframes inherit the embedding
// document's CSP, so any policy set here would silently govern every proxied page — that
// is how inline handlers, eval-based frameworks and runtime fetch() all got blocked. We
// therefore ship no CSP at all and keep only the headers that cannot break content.
const shellHardening = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  originAgentCluster: false,
});
const shellCompression = compression();

function shellOnly(mw) {
  return (req, res, next) => (req.path.startsWith("/api/") ? next() : mw(req, res, next));
}

app.use(shellOnly(shellHardening));
app.use(shellOnly(shellCompression));

// Body parsers ONLY apply outside /api/*. Proxy routes install express.raw locally so
// arbitrary bodies (multipart, application/octet-stream, application/json) are forwarded
// upstream intact instead of being consumed here.
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  express.json({ limit: "2mb" })(req, res, (err) => {
    if (err) return next(err);
    express.urlencoded({ extended: false, limit: "2mb" })(req, res, next);
  });
});

const apiLimiter = createLimiter({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX,
  name: "api",
});

const authLimiter = createLimiter({
  windowMs: config.AUTH_RATE_WINDOW_MS,
  max: config.AUTH_RATE_MAX,
  name: "auth",
});

app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    node: process.version,
    eruda: config.ERUDA_VERSION,
    authRequired: !!config.ACCESS_PASSWORD,
    warnings: config.warnings.length,
  }),
);
app.get("/vendor/eruda.js", (_req, res) => {
  if (!ERUDA_PATH) return res.status(404).type("text/plain").send("eruda is not installed");
  res.type("application/javascript");
  res.setHeader("cache-control", "public, max-age=86400, immutable");
  res.sendFile(ERUDA_PATH);
});
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// Auth endpoints.
app.get("/auth/status", (req, res) =>
  res.json({ required: !!config.ACCESS_PASSWORD, authenticated: auth.isAuthed(req) }),
);
app.post("/auth/login", authLimiter, (req, res) => {
  if (!config.ACCESS_PASSWORD) return res.json({ ok: true });
  if (!auth.verifyPassword(req.body?.password)) {
    return res.status(401).json({ ok: false, error: "Invalid password" });
  }
  const sid = auth.createSession(req);
  res.cookie(auth.COOKIE_NAME, sid, auth.cookieOptions());
  res.json({ ok: true });
});
app.post("/auth/logout", (req, res) => {
  const sid = auth.readSessionId(req);
  auth.destroySession(sid);
  res.clearCookie(auth.COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// Proxy routes.
const rawBody = express.raw({ type: "*/*", limit: config.MAX_REQUEST_BYTES });
app.use("/api/page", auth.requireAuth, apiLimiter, rawBody, (req, res) =>
  handleProxy(req, res, "page"),
);
app.use("/api/resource", auth.requireAuth, apiLimiter, rawBody, (req, res) =>
  handleProxy(req, res, "resource"),
);

// Static assets and SPA fallback (only GET/HEAD; anything else is a real 404).
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "InSite API route not found.", path: req.path });
  }
  if (req.method === "GET" || req.method === "HEAD") {
    return res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  }
  return res.status(404).send("InSite: route not found.");
});

// Central error handler — no stack trace leaks to clients. Preserves the status set by
// well-typed errors (express.raw 413 for oversize bodies, body-parser 400s, etc.) so
// platform monitoring sees the right class of failure.
app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, "Unhandled error");
  if (res.headersSent) return res.destroy();
  const status = Number(err.status || err.statusCode) || 500;
  res.status(status).json({ error: err.expose ? err.message : "Internal server error" });
});

const server = http.createServer(app);
ws.attach(server);

server.on("error", (err) => {
  // EADDRINUSE / EACCES arrive here, not as an exception.
  console.error(`\n[InSite] FATAL: could not listen on port ${config.PORT}: ${err.message}\n`);
  process.exit(1);
});

// Bind all interfaces explicitly. Omitting the host can bind IPv6-only on some container
// platforms, leaving the app unreachable from the edge proxy for no visible reason.
server.listen(config.PORT, "0.0.0.0", () => {
  listening = true;
  logger.info(
    {
      port: config.PORT,
      eruda: config.ERUDA_VERSION,
      node: process.version,
      env: config.NODE_ENV,
      authRequired: !!config.ACCESS_PASSWORD,
    },
    "InSite listening",
  );
  for (const message of config.warnings) logger.warn(message);
  if (!config.ACCESS_PASSWORD && config.IS_PROD) {
    logger.warn(
      "==================================================================\n" +
        "  InSite is running WITHOUT authentication.\n" +
        "  Set ACCESS_PASSWORD in your platform's environment settings.\n" +
        "==================================================================",
    );
  }
});

// Graceful shutdown so in-flight requests get a chance to finish.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ sig }, "Shutting down");
  server.close(() => process.exit(0));
  // Fallback: force-exit if a stuck connection would keep the process alive too long.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = { app, server };
