"use strict";

process.env.ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "correct-horse-battery-staple";

const test = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../src/security/auth");

test("verifyPassword uses timing-safe compare and accepts the right value", () => {
  assert.equal(auth.verifyPassword("correct-horse-battery-staple"), true);
});

test("verifyPassword rejects wrong values (length mismatch OK)", () => {
  assert.equal(auth.verifyPassword("nope"), false);
  assert.equal(auth.verifyPassword(""), false);
  assert.equal(auth.verifyPassword(null), false);
  assert.equal(auth.verifyPassword("correct-horse-battery-stapl"), false);
  assert.equal(auth.verifyPassword("correct-horse-battery-staplX"), false);
});

test("createSession → isAuthed round-trip", () => {
  const req = { headers: {}, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } };
  const sid = auth.createSession(req);
  const req2 = { headers: { cookie: `insite_session=${sid}` }, path: "/api/page/x" };
  assert.equal(auth.isAuthed(req2), true);
  auth.destroySession(sid);
  assert.equal(auth.isAuthed(req2), false);
});

test("readSessionId parses the cookie header", () => {
  const req = { headers: { cookie: "foo=bar; insite_session=xyz; baz=qux" } };
  assert.equal(auth.readSessionId(req), "xyz");
});

test("Unknown session id is not accepted", () => {
  const req = { headers: { cookie: "insite_session=totally-fake" }, path: "/api/page/x" };
  assert.equal(auth.isAuthed(req), false);
});
