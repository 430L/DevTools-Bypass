"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isPrivateAddress,
  unmapIPv4,
  hostBlockedByName,
  hostInAllowlist,
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
