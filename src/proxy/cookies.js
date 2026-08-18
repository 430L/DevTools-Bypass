"use strict";

const { CookieJar } = require("tough-cookie");
const { getDomain } = require("tldts");

// Per-session cookie jars keyed by eTLD+1 so that Domain=.example.com cookies set at
// www.example.com are still offered when the same session visits accounts.example.com.
// Falls back to the raw hostname when tldts cannot classify the host (bare hostname,
// IP literal, etc.), keeping the strict-scoping behaviour for those cases.
//   sid → jarKey → { jar, lastUsed }
const jars = new Map();
const SWEEP_MS = 10 * 60 * 1000;
const IDLE_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [sid, per] of jars) {
    for (const [key, entry] of per) {
      if (now - entry.lastUsed > IDLE_MS) per.delete(key);
    }
    if (per.size === 0) jars.delete(sid);
  }
}, SWEEP_MS).unref();

function jarKey(hostname) {
  return getDomain(hostname, { allowPrivateDomains: true }) || hostname;
}

function jarFor(sid, hostname) {
  if (!sid) return null;
  const key = jarKey(hostname);
  let per = jars.get(sid);
  if (!per) {
    per = new Map();
    jars.set(sid, per);
  }
  let entry = per.get(key);
  if (!entry) {
    entry = {
      jar: new CookieJar(undefined, { rejectPublicSuffixes: false }),
      lastUsed: Date.now(),
    };
    per.set(key, entry);
  }
  entry.lastUsed = Date.now();
  return entry.jar;
}

function dropSession(sid) {
  jars.delete(sid);
}

async function getCookieHeader(sid, target) {
  const jar = jarFor(sid, target.hostname);
  if (!jar) return "";
  return jar.getCookieString(target.href);
}

// Store upstream Set-Cookie headers verbatim. Handing tough-cookie the raw header line
// preserves Domain, Path, Secure, SameSite, HttpOnly, Max-Age, Expires without our own
// (previously lossy) reconstruction, so cross-subdomain SSO cookies survive.
async function storeSetCookies(sid, target, headerLines) {
  const jar = jarFor(sid, target.hostname);
  if (!jar || !headerLines?.length) return;
  for (const line of headerLines) {
    try {
      await jar.setCookie(line, target.href, { ignoreError: true, http: true });
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

module.exports = {
  jarFor,
  jarKey,
  dropSession,
  getCookieHeader,
  storeSetCookies,
  extractSetCookies,
};
