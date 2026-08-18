"use strict";

// End-to-end coverage of the real request path: browser -> proxy -> upstream -> rewrite
// -> browser. Previously untestable, because the SSRF guard (correctly) refuses loopback
// targets and there was no opt-out; ALLOW_PRIVATE_TARGETS exists for exactly this suite.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const ENTRY = path.join(__dirname, "..", "server.js");
const PASSWORD = "integration-password";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Upstream site the proxy will fetch from.
function startFixture(port) {
  const seen = { posts: [], cookies: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    seen.cookies.push(req.headers.cookie || null);

    if (url.pathname === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(
        `<html><head><link rel="stylesheet" href="/style.css"></head>` +
          `<body><img src="/logo.png"><a href="/other">go</a>` +
          `<script src="/app.js"></script></body></html>`,
      );
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/page" });
      return res.end();
    }
    if (url.pathname === "/img-redirect") {
      res.writeHead(302, { location: "/logo.png" });
      return res.end();
    }
    if (url.pathname === "/logo.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    if (url.pathname === "/set-cookie") {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "sid=abc123; Path=/; HttpOnly",
      });
      return res.end("<html><body>cookie set</body></html>");
    }
    if (url.pathname === "/echo-cookie") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ cookie: req.headers.cookie || null }));
    }
    if (url.pathname === "/echo-post") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      return req.on("end", () => {
        seen.posts.push({ body, type: req.headers["content-type"] || null });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: body, method: req.method }));
      });
    }
    if (url.pathname === "/latin1") {
      // "Café Münster" encoded as windows-1252, declared as such.
      const buf = Buffer.from([
        0x43, 0x61, 0x66, 0xe9, 0x20, 0x4d, 0xfc, 0x6e, 0x73, 0x74, 0x65, 0x72,
      ]);
      res.writeHead(200, { "content-type": "text/html; charset=windows-1252" });
      return res.end(
        Buffer.concat([Buffer.from("<html><body>"), buf, Buffer.from("</body></html>")]),
      );
    }
    if (url.pathname === "/bad-header") {
      // A header value with a raw newline would make res.setHeader throw downstream.
      res.socket.write(
        "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nx-ok: fine\r\n\r\nbody-here",
      );
      return res.socket.end();
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ server, seen })),
  );
}

async function waitForHealth(port, proc, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`proxy exited early (${proc.exitCode})`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("proxy never became healthy");
}

const enc = (u) => Buffer.from(u, "utf8").toString("base64url");

test("proxy end-to-end against a local fixture", async (t) => {
  const fixturePort = await freePort();
  const proxyPort = await freePort();
  const { server: fixture, seen } = await startFixture(fixturePort);
  const origin = `http://127.0.0.1:${fixturePort}`;

  const proc = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(proxyPort),
      ACCESS_PASSWORD: PASSWORD,
      ALLOW_PRIVATE_TARGETS: "1",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => {
    log += d;
  });
  proc.stderr.on("data", (d) => {
    log += d;
  });

  t.after(() => {
    proc.kill("SIGKILL");
    fixture.close();
  });

  try {
    await waitForHealth(proxyPort, proc);
  } catch (e) {
    throw new Error(`${e.message}\n--- proxy output ---\n${log}`);
  }

  const base = `http://127.0.0.1:${proxyPort}`;

  // Authenticate and keep the session cookie for subsequent calls.
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: "manual",
  });
  assert.equal(login.status, 200);
  const sessionCookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(sessionCookie.includes("insite_session"), "should issue a session cookie");
  const auth = { cookie: sessionCookie };

  await t.test("HTML is rewritten so subresources route through /api/resource/", async () => {
    const r = await fetch(`${base}/api/page/${enc(`${origin}/page`)}`, { headers: auth });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /\/api\/resource\/[A-Za-z0-9_-]+/, "stylesheet/script/img must be proxied");
    assert.ok(!html.includes('href="/style.css"'), "raw relative asset URL must be gone");
    assert.ok(html.includes("window.__INSITE__"), "boot payload must be injected");
    assert.ok(html.includes("/insite.js"), "client script must be injected");
    // Anchors are absolutized so the srcdoc client can resolve them.
    assert.ok(html.includes(`${origin}/other`), "anchors must be absolutized to the target");
  });

  await t.test("page redirects rewrite Location to /api/page/", async () => {
    const r = await fetch(`${base}/api/page/${enc(`${origin}/redirect`)}`, {
      headers: auth,
      redirect: "manual",
    });
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location"), /^\/api\/page\/[A-Za-z0-9_-]+$/);
  });

  await t.test("resource redirects rewrite Location to /api/resource/", async () => {
    const r = await fetch(`${base}/api/resource/${enc(`${origin}/img-redirect`)}`, {
      headers: auth,
      redirect: "manual",
    });
    assert.equal(r.status, 302);
    assert.match(
      r.headers.get("location"),
      /^\/api\/resource\/[A-Za-z0-9_-]+$/,
      "an image redirect must not land on the HTML pipeline",
    );
  });

  await t.test("binary bodies stream through byte-for-byte", async () => {
    const r = await fetch(`${base}/api/resource/${enc(`${origin}/logo.png`)}`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    const got = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(got, PNG);
  });

  await t.test("Set-Cookie is captured in the jar and never returned to the browser", async () => {
    const r = await fetch(`${base}/api/page/${enc(`${origin}/set-cookie`)}`, { headers: auth });
    assert.equal(r.status, 200);
    const passedThrough = r.headers.getSetCookie();
    assert.equal(
      passedThrough.length,
      0,
      "target cookies must stay server-side, never reach the browser",
    );

    // The jar must replay it upstream on the next request to the same site.
    const echo = await fetch(`${base}/api/resource/${enc(`${origin}/echo-cookie`)}`, {
      headers: auth,
    });
    const body = await echo.json();
    assert.match(String(body.cookie), /sid=abc123/, "jar must replay the target's cookie upstream");
  });

  await t.test("the proxy's own session cookie is never forwarded upstream", async () => {
    const echo = await fetch(`${base}/api/resource/${enc(`${origin}/echo-cookie`)}`, {
      headers: auth,
    });
    const body = await echo.json();
    assert.ok(
      !String(body.cookie || "").includes("insite_session"),
      "the proxy session token must never leak to the target",
    );
  });

  await t.test("POST bodies reach the upstream intact", async () => {
    const payload = JSON.stringify({ hello: "world", n: 42 });
    const r = await fetch(`${base}/api/resource/${enc(`${origin}/echo-post`)}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: payload,
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.method, "POST");
    assert.equal(body.received, payload, "request body must not be dropped");
    const last = seen.posts.at(-1);
    assert.match(last.type, /application\/json/, "content-type must be forwarded");
  });

  await t.test("non-UTF-8 pages are decoded with their declared charset", async () => {
    const r = await fetch(`${base}/api/page/${enc(`${origin}/latin1`)}`, { headers: auth });
    const html = await r.text();
    assert.ok(html.includes("Café"), `expected decoded text, got: ${html.slice(0, 200)}`);
    assert.ok(html.includes("Münster"));
    assert.match(r.headers.get("content-type") || "", /charset=utf-8/);
  });

  await t.test("no CSP is emitted on shell or proxied responses", async () => {
    const shell = await fetch(`${base}/`);
    assert.equal(shell.headers.get("content-security-policy"), null);
    const page = await fetch(`${base}/api/page/${enc(`${origin}/page`)}`, { headers: auth });
    assert.equal(page.headers.get("content-security-policy"), null);
  });

  await t.test("unauthenticated proxy requests are refused", async () => {
    const r = await fetch(`${base}/api/page/${enc(`${origin}/page`)}`);
    assert.equal(r.status, 401);
  });

  await t.test("the process is still alive after all of that", () => {
    assert.equal(proc.exitCode, null, `proxy died during the suite:\n${log}`);
  });
});
