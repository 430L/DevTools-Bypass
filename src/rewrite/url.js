"use strict";

const MAX_URL_LENGTH = 8 * 1024;

function encodeTarget(url) {
  return Buffer.from(url, "utf8").toString("base64url");
}

function decodeTarget(key) {
  const s = Buffer.from(String(key || ""), "base64url").toString("utf8");
  if (!s || s.length > MAX_URL_LENGTH) return "";
  return s;
}

// Resolve `raw` against `base`, return a URL object with credentials removed,
// or null if the input is not a plain HTTP(S) URL.
function cleanTarget(raw, base) {
  try {
    const u = new URL(raw, base);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.username = "";
    u.password = "";
    return u;
  } catch {
    return null;
  }
}

function proxyEndpoint(target, kind = "resource") {
  return `/api/${kind}/${encodeTarget(target.href)}`;
}

const NON_HTTP = /^(?:#|data:|blob:|javascript:|mailto:|tel:|about:|sms:|magnet:|ftp:|file:)/i;

function isNonHttp(raw) {
  return typeof raw !== "string" || raw === "" || NON_HTTP.test(raw);
}

module.exports = {
  encodeTarget,
  decodeTarget,
  cleanTarget,
  proxyEndpoint,
  isNonHttp,
  MAX_URL_LENGTH,
};
