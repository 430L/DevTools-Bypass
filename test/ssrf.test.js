"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isPrivateAddress,
  unmapIPv4,
  hostBlockedByName,
  hostInAllowlist,
  validateTarget,
} = require("../src/security/ssrf");

test("IPv4 private ranges are blocked", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.0.0.1"), true);
  assert.equal(isPrivateAddress("172.16.5.5"), true);
  assert.equal(isPrivateAddress("172.31.255.255"), true);
  assert.equal(isPrivateAddress("192.168.1.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("100.64.1.1"), true);
  assert.equal(isPrivateAddress("198.18.0.1"), true);
  assert.equal(isPrivateAddress("0.0.0.0"), true);
  assert.equal(isPrivateAddress("224.0.0.1"), true);
  assert.equal(isPrivateAddress("255.255.255.255"), true);
});

test("Public IPv4 addresses are allowed", () => {
  assert.equal(isPrivateAddress("1.1.1.1"), false);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("140.82.112.3"), false);
});

test("IPv4-mapped IPv6 (::ffff:*) is normalized and blocked", () => {
  assert.equal(unmapIPv4("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateAddress("::ffff:169.254.169.254"), true);
  assert.equal(isPrivateAddress("::ffff:c0a8:0101"), true); // 192.168.1.1
  assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false);
});

test("IPv6 loopback / ULA / link-local blocked", () => {
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("::"), true);
  assert.equal(isPrivateAddress("fc00::1"), true);
  assert.equal(isPrivateAddress("fd00::1"), true);
  assert.equal(isPrivateAddress("fe80::1"), true);
  assert.equal(isPrivateAddress("ff00::1"), true);
  assert.equal(isPrivateAddress("2001:db8::1"), true);
});

test("Public IPv6 allowed", () => {
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("Bad / unknown addresses treated as private (fail-closed)", () => {
  assert.equal(isPrivateAddress(""), true);
  assert.equal(isPrivateAddress("not-an-ip"), true);
});

test("Internal TLDs blocked by name", () => {
  assert.equal(hostBlockedByName("localhost"), true);
  assert.equal(hostBlockedByName("api.localhost"), true);
  assert.equal(hostBlockedByName("metadata.google.internal"), true);
  assert.equal(hostBlockedByName("host.internal"), true);
  assert.equal(hostBlockedByName("db.local"), true);
  assert.equal(hostBlockedByName("srv.consul"), true);
  assert.equal(hostBlockedByName("example.com"), false);
});

test("ALLOWED_HOSTS allowlist behaviour", () => {
  // Empty allowlist = any host allowed.
  assert.equal(hostInAllowlist("example.com"), true);
});

test("validateTarget rejects IPv6-in-URL bracket forms of loopback", async () => {
  // URL.hostname preserves the brackets and Node normalizes ::ffff:127.0.0.1 to
  // ::ffff:7f00:1. Both must be blocked before DNS is consulted.
  const cases = [
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
  ];
  for (const raw of cases) {
    await assert.rejects(() => validateTarget(new URL(raw)), /blocked|Private|internal/i);
  }
});

test("validateTarget rejects non-HTTP schemes early", async () => {
  await assert.rejects(() => validateTarget(new URL("javascript:alert(1)")), /HTTP and HTTPS/);
  await assert.rejects(() => validateTarget(new URL("data:text/plain,foo")), /HTTP and HTTPS/);
});

test("ALLOW_PRIVATE_TARGETS defaults to OFF (must never ship enabled)", () => {
  // Guard against the test-only SSRF escape hatch leaking into a real deployment.
  const config = require("../src/config");
  assert.equal(
    config.ALLOW_PRIVATE_TARGETS,
    false,
    "ALLOW_PRIVATE_TARGETS must be false unless explicitly set for tests",
  );
});
