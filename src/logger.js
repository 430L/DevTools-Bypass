"use strict";

const config = require("./config");

const redact = {
  paths: [
    "req.headers.cookie",
    "req.headers.authorization",
    'req.headers["proxy-authorization"]',
    "headers.cookie",
    "headers.authorization",
    "*.password",
    "password",
  ],
  censor: "[REDACTED]",
  remove: false,
};

// pino-pretty is a devDependency. A production install (`npm ci --omit=dev`) does not
// have it, and pino THROWS "unable to determine transport target" when it cannot resolve
// one. That used to kill the process at import time, so only configure the transport
// once we know the module is actually present.
function prettyTransport() {
  if (config.IS_PROD) return undefined;
  try {
    require.resolve("pino-pretty");
  } catch {
    return undefined;
  }
  return { target: "pino-pretty", options: { singleLine: true, translateTime: "SYS:HH:MM:ss" } };
}

// Last-resort logger so that logging can never be the reason the server fails to start.
function consoleLogger() {
  const emit =
    (stream, level) =>
    (...args) => {
      const [first, second] = args;
      const msg = typeof first === "string" ? first : second || "";
      const data = typeof first === "object" && first !== null ? first : undefined;
      stream(`[InSite] ${level}: ${msg}${data ? ` ${JSON.stringify(data)}` : ""}`);
    };
  return {
    trace: emit(console.debug.bind(console), "trace"),
    debug: emit(console.debug.bind(console), "debug"),
    info: emit(console.info.bind(console), "info"),
    warn: emit(console.warn.bind(console), "warn"),
    error: emit(console.error.bind(console), "error"),
    fatal: emit(console.error.bind(console), "fatal"),
  };
}

function buildLogger() {
  try {
    const pino = require("pino");
    return pino({
      level: config.LOG_LEVEL,
      redact,
      base: undefined,
      transport: prettyTransport(),
    });
  } catch (err) {
    const fallback = consoleLogger();
    fallback.warn(`pino unavailable (${err?.message}) — using console logging`);
    return fallback;
  }
}

const logger = buildLogger();

// Strip credentials + query string from a target URL before logging it.
function safeUrl(u) {
  if (!u) return "?";
  try {
    const url = typeof u === "string" ? new URL(u) : new URL(u.href);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "?";
  }
}

module.exports = { logger, safeUrl };
