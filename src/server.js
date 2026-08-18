"use strict";

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
const ERUDA_PATH = require.resolve("eruda");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.TRUST_PROXY_HOPS);

// Restrictive CSP for the shell only; proxied bodies bypass this because they render inside
// a same-origin srcdoc iframe whose own CSP is stripped by the rewriter.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "font-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "frame-src": ["'self'"],
        "worker-src": ["'self'", "blob:"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
  }),
);

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

// Static + shell.
app.use(compression());
app.get("/healthz", (_req, res) =>
  res.json({ ok: true, node: process.version, eruda: config.ERUDA_VERSION }),
);
app.get("/vendor/eruda.js", (_req, res) => {
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

// Central error handler — no stack trace leaks to clients.
app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, "Unhandled error");
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: "Internal server error" });
});

const server = http.createServer(app);
ws.attach(server);

server.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, eruda: config.ERUDA_VERSION, node: process.version },
    "InSite listening",
  );
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
