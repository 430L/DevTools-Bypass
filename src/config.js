"use strict";

const crypto = require("node:crypto");

function num(name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name}: not a number (${raw})`);
  return Math.max(min, Math.min(max, n));
}

function str(name, def = "") {
  const v = process.env[name];
  return v === undefined ? def : String(v);
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
const ACCESS_PASSWORD = str("ACCESS_PASSWORD");

if (NODE_ENV === "production" && !ACCESS_PASSWORD) {
  // Fail fast: production deployments MUST set ACCESS_PASSWORD.
  throw new Error("ACCESS_PASSWORD must be set in production");
}

const SESSION_SECRET = str("SESSION_SECRET") || crypto.randomBytes(32).toString("hex");

module.exports = {
  NODE_ENV,
  IS_PROD: NODE_ENV === "production",
  PORT: num("PORT", 3000, { min: 1, max: 65535 }),
  ACCESS_PASSWORD,
  ALLOWED_HOSTS: csv("ALLOWED_HOSTS"),

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
