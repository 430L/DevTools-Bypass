"use strict";

const crypto = require("node:crypto");

// Startup problems are COLLECTED, never thrown. A configuration mistake must never
// prevent the process from binding a port — a dead process behind a reverse proxy
// surfaces to users as an opaque 502 with nothing to debug. src/server.js prints
// these once the server is listening.
const warnings = [];

function warn(message) {
  warnings.push(message);
}

function num(name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warn(`env ${name}="${raw}" is not a number — falling back to ${def}`);
    return def;
  }
  const clamped = Math.max(min, Math.min(max, n));
  if (clamped !== n) {
    warn(`env ${name}=${n} is out of range [${min}, ${max}] — clamped to ${clamped}`);
  }
  return clamped;
}

function str(name, def = "") {
  const v = process.env[name];
  return v === undefined ? def : String(v);
}

function bool(name, def = false) {
  const v = str(name).trim().toLowerCase();
  if (!v) return def;
  return ["1", "true", "yes", "on"].includes(v);
}

function csv(name) {
  return new Set(
    str(name)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

const NODE_ENV = str("NODE_ENV", "development");
const IS_PROD = NODE_ENV === "production";
const ACCESS_PASSWORD = str("ACCESS_PASSWORD");

if (!ACCESS_PASSWORD) {
  warn(
    IS_PROD
      ? "ACCESS_PASSWORD is not set — this deployment is running OPEN. Anyone who can reach this URL can proxy arbitrary sites through it. Set ACCESS_PASSWORD in your platform's environment settings."
      : "ACCESS_PASSWORD is not set — running in open mode (fine for local development).",
  );
}

// Escape hatch used ONLY by the integration tests so they can proxy a fixture server on
// 127.0.0.1. Never enable this in a deployment: it disables the private-address half of
// the SSRF protection.
const ALLOW_PRIVATE_TARGETS = bool("ALLOW_PRIVATE_TARGETS", false);
if (ALLOW_PRIVATE_TARGETS) {
  warn(
    "ALLOW_PRIVATE_TARGETS is enabled — SSRF protection against private/loopback addresses is DISABLED. This must only ever be used for local testing.",
  );
}

const SESSION_SECRET = str("SESSION_SECRET") || crypto.randomBytes(32).toString("hex");

module.exports = {
  warnings,

  NODE_ENV,
  IS_PROD,
  PORT: num("PORT", 3000, { min: 1, max: 65535 }),
  ACCESS_PASSWORD,
  ALLOWED_HOSTS: csv("ALLOWED_HOSTS"),
  ALLOW_PRIVATE_TARGETS,

  MAX_RESPONSE_BYTES: num("MAX_RESPONSE_MB", 25, { min: 1, max: 4096 }) * 1024 * 1024,
  MAX_REQUEST_BYTES: num("MAX_REQUEST_MB", 25, { min: 1, max: 4096 }) * 1024 * 1024,
  REQUEST_TIMEOUT_MS: num("REQUEST_TIMEOUT_MS", 20000, { min: 1000, max: 120000 }),

  RATE_LIMIT_WINDOW_MS: num("RATE_LIMIT_WINDOW_MS", 60000, { min: 1000 }),
  RATE_LIMIT_MAX: num("RATE_LIMIT_MAX", 120, { min: 1 }),
  AUTH_RATE_WINDOW_MS: num("AUTH_RATE_WINDOW_MS", 15 * 60 * 1000, { min: 60000 }),
  AUTH_RATE_MAX: num("AUTH_RATE_MAX", 5, { min: 1 }),

  SESSION_TTL_MS: num("SESSION_TTL_MS", 7 * 24 * 60 * 60 * 1000, { min: 60000 }),
  SESSION_SECRET,

  TRUST_PROXY_HOPS: num("TRUST_PROXY_HOPS", 1, { min: 0, max: 8 }),
  LOG_LEVEL: str("LOG_LEVEL", "info"),

  ERUDA_VERSION: "3.4.3",
};
