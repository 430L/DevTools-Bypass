"use strict";

const crypto = require("node:crypto");
const config = require("../config");

const COOKIE_NAME = "insite_session";
const SWEEP_MS = 60 * 1000;

// { sid → { expiresAt, createdAt, userAgent, ip } }
const sessions = new Map();

// Periodic sweep of expired sessions. `unref` so the timer never blocks process exit.
setInterval(() => {
  const now = Date.now();
  for (const [sid, meta] of sessions) if (meta.expiresAt <= now) sessions.delete(sid);
}, SWEEP_MS).unref();

function newSessionId() {
  return crypto.randomBytes(32).toString("base64url");
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function bufEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyPassword(input) {
  if (!config.ACCESS_PASSWORD) return true;
  const a = Buffer.from(String(input ?? ""), "utf8");
  const b = Buffer.from(config.ACCESS_PASSWORD, "utf8");
  // Timing-safe on the byte comparison; the length branch is unavoidable.
  if (a.length !== b.length) {
    // Still touch the compare so an attacker cannot easily distinguish length mismatches
    // from wrong bytes via wall-clock timing. The result is discarded.
    try {
      crypto.timingSafeEqual(a, a);
    } catch {
      /* noop */
    }
    return false;
  }
  return bufEqual(a, b);
}

function createSession(req) {
  const sid = newSessionId();
  sessions.set(sid, {
    createdAt: Date.now(),
    expiresAt: Date.now() + config.SESSION_TTL_MS,
    userAgent: String(req.headers["user-agent"] || ""),
    ip: req.ip || req.socket.remoteAddress || "",
  });
  return sid;
}

function destroySession(sid) {
  if (sid) sessions.delete(sid);
}

function readSessionId(req) {
  return parseCookies(req.headers.cookie || "")[COOKIE_NAME] || "";
}

function isAuthed(req) {
  if (!config.ACCESS_PASSWORD) return true;
  const sid = readSessionId(req);
  if (!sid) return false;
  const meta = sessions.get(sid);
  if (!meta) return false;
  if (meta.expiresAt <= Date.now()) {
    sessions.delete(sid);
    return false;
  }
  return true;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: config.IS_PROD,
    path: "/",
    maxAge: config.SESSION_TTL_MS,
  };
}

// Express middleware: require a valid session before continuing (JSON error for /api/*).
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith("/api/"))
    return res.status(401).json({ error: "Authentication required." });
  return res.status(401).send("Authentication required.");
}

module.exports = {
  COOKIE_NAME,
  createSession,
  destroySession,
  readSessionId,
  isAuthed,
  requireAuth,
  verifyPassword,
  cookieOptions,
  sessions, // exported for tests
};
