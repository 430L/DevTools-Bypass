"use strict";

const setCookieParser = require("set-cookie-parser");
const { CookieJar, Cookie } = require("tough-cookie");

// Per-session per-target cookie jars.
//   session id → target origin → tough-cookie CookieJar
// Isolates target sessions from the browser AND from other proxy users.
const jars = new Map();
const SWEEP_MS = 10 * 60 * 1000;
const IDLE_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [sid, per] of jars) {
    for (const [origin, entry] of per) {
      if (now - entry.lastUsed > IDLE_MS) per.delete(origin);
    }
    if (per.size === 0) jars.delete(sid);
  }
}, SWEEP_MS).unref();

function jarFor(sid, origin) {
  if (!sid) return null;
  let per = jars.get(sid);
  if (!per) {
    per = new Map();
    jars.set(sid, per);
  }
  let entry = per.get(origin);
  if (!entry) {
    entry = {
      jar: new CookieJar(undefined, { rejectPublicSuffixes: false }),
      lastUsed: Date.now(),
    };
    per.set(origin, entry);
  }
  entry.lastUsed = Date.now();
  return entry.jar;
}

function dropSession(sid) {
  jars.delete(sid);
}

async function getCookieHeader(sid, target) {
  const jar = jarFor(sid, target.origin);
  if (!jar) return "";
  return jar.getCookieString(target.href);
}

// Store upstream Set-Cookie headers in the jar. Never emitted back to the client.
async function storeSetCookies(sid, target, headerLines) {
  const jar = jarFor(sid, target.origin);
  if (!jar || !headerLines?.length) return;
  const parsed = setCookieParser.parse(headerLines, { decodeValues: false });
  for (const c of parsed) {
    const attrs = [
      `${c.name}=${c.value}`,
      c.expires ? `Expires=${new Date(c.expires).toUTCString()}` : "",
      c.maxAge != null ? `Max-Age=${c.maxAge}` : "",
      c.path ? `Path=${c.path}` : "Path=/",
      c.httpOnly ? "HttpOnly" : "",
      c.sameSite ? `SameSite=${c.sameSite}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    const cookie = Cookie.parse(attrs);
    if (!cookie) continue;
    try {
      await jar.setCookie(cookie, target.href, { ignoreError: true });
    } catch {
      /* ignore malformed */
    }
  }
}

// Extract Set-Cookie values from a Fetch Headers object. Uses getSetCookie when present
// (Node 20+); falls back to a manual walk otherwise.
function extractSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const out = [];
  headers.forEach((v, k) => {
    if (k.toLowerCase() === "set-cookie") out.push(v);
  });
  return out;
}

module.exports = { jarFor, dropSession, getCookieHeader, storeSetCookies, extractSetCookies };
