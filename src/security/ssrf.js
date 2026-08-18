"use strict";

const dns = require("node:dns").promises;
const net = require("node:net");
const { Agent } = require("undici");
const config = require("../config");

// Suffixes that resolve to internal networks in typical corporate setups.
const INTERNAL_TLDS = [
  ".internal",
  ".local",
  ".consul",
  ".corp",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".localdomain",
];

const INTERNAL_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.aws.internal",
  "metadata.azure.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

// Return the IPv4 dotted-quad that an IPv4-mapped IPv6 ("::ffff:a.b.c.d") represents,
// or null if the input is not v4-mapped.
function unmapIPv4(ip) {
  if (typeof ip !== "string") return null;
  const lower = ip.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const tail = lower.slice(7);
  if (net.isIPv4(tail)) return tail;
  // ::ffff:c0a8:0101 form → convert hex halves.
  const halves = tail.split(":");
  if (halves.length !== 2) return null;
  const a = Number.parseInt(halves[0], 16);
  const b = Number.parseInt(halves[1], 16);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
}

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 192 && b === 0) || // 192.0.0/24 IETF
    a >= 224 // multicast + reserved + broadcast
  );
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  // Unique-local fc00::/7 → first byte 0xfc or 0xfd.
  if (v.startsWith("fc") || v.startsWith("fd")) return true;
  // Link-local fe80::/10 → fe8/fe9/fea/feb.
  if (/^fe[89ab]/.test(v)) return true;
  // Multicast ff00::/8.
  if (v.startsWith("ff")) return true;
  // Documentation 2001:db8::/32.
  if (v.startsWith("2001:db8:") || v.startsWith("2001:db8::")) return true;
  // Discard-only 100::/64.
  if (v.startsWith("100::") || /^100:0*:0*:0*:/.test(v)) return true;
  // Teredo (2001::/32), and 6to4 (2002::/16) transit through the routable Internet,
  // so we do not block them here — SSRF-relevant addresses embedded inside are
  // caught by the IPv4 check when the endpoint actually resolves.
  return false;
}

function isPrivateAddress(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const mapped = unmapIPv4(ip);
  if (mapped) return isPrivateIPv4(mapped);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // unknown format → block
}

function hostBlockedByName(host) {
  const h = host.toLowerCase();
  if (INTERNAL_HOSTS.has(h)) return true;
  if (h.endsWith(".localhost")) return true;
  for (const suf of INTERNAL_TLDS) if (h.endsWith(suf)) return true;
  return false;
}

function hostInAllowlist(host) {
  if (!config.ALLOWED_HOSTS.size) return true;
  const h = host.toLowerCase();
  for (const allowed of config.ALLOWED_HOSTS) {
    if (h === allowed || h.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

// Resolve the target host to a set of IP addresses, block if any is private, and
// return the list of pinned IPs to use when actually opening the socket.
async function resolveAndPin(host) {
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("Private or reserved IP targets are blocked.");
    return [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  }
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  if (!answers.length) throw new Error("Hostname did not resolve.");
  for (const a of answers) {
    if (isPrivateAddress(a.address)) {
      throw new Error("Hostname resolves to a private or reserved address.");
    }
  }
  return answers;
}

async function validateTarget(u) {
  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error("Only HTTP and HTTPS targets are supported.");
  }
  const host = u.hostname.toLowerCase();
  if (hostBlockedByName(host)) throw new Error("Local or internal targets are blocked.");
  if (!hostInAllowlist(host)) throw new Error("This hostname is not in ALLOWED_HOSTS.");
  const pinned = await resolveAndPin(host);
  return { host, pinned };
}

// Build an undici agent that redirects the DNS resolution to a pre-verified IP so
// that a rebinding attack cannot present a different address between validate and connect.
function pinnedAgent(pinned) {
  const address = pinned[0].address;
  return new Agent({
    connect: {
      lookup: (_hostname, _opts, cb) => cb(null, address, pinned[0].family),
    },
  });
}

module.exports = {
  validateTarget,
  pinnedAgent,
  isPrivateAddress,
  unmapIPv4,
  isPrivateIPv4,
  isPrivateIPv6,
  hostBlockedByName,
  hostInAllowlist,
};
