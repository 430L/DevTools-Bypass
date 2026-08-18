"use strict";

const pino = require("pino");
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

const transport = !config.IS_PROD
  ? { target: "pino-pretty", options: { singleLine: true, translateTime: "SYS:HH:MM:ss" } }
  : undefined;

const logger = pino({
  level: config.LOG_LEVEL,
  redact,
  base: undefined,
  transport,
});

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
