"use strict";

// Regression suite for the class of bug that produced a Cloudflare 502 in production:
// the process failed at import time and never bound a port. Every environment
// combination below MUST end with a listening server answering /healthz.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");

const ENTRY = path.join(__dirname, "..", "server.js");

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

async function waitForHealth(port, proc, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`process exited early with code ${proc.exitCode}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return await r.json();
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`never became healthy: ${lastErr?.message || "timeout"}`);
}

// Start the server with a specific environment and assert it serves /healthz.
async function bootsWith(envOverrides) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  // Explicit undefined means "unset this variable".
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const proc = spawn(process.execPath, [ENTRY], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (d) => {
    output += d;
  });
  proc.stderr.on("data", (d) => {
    output += d;
  });

  try {
    const health = await waitForHealth(port, proc);
    return { health, output };
  } catch (err) {
    throw new Error(`${err.message}\n--- process output ---\n${output}`);
  } finally {
    proc.kill("SIGKILL");
  }
}

test("boots in production with no ACCESS_PASSWORD (the 502 regression)", async () => {
  const { health } = await bootsWith({ NODE_ENV: "production", ACCESS_PASSWORD: undefined });
  assert.equal(health.ok, true);
  // Open mode: auth is not required, and the misconfiguration is surfaced as a warning.
  assert.equal(health.authRequired, false);
  assert.ok(health.warnings > 0, "should report at least one startup warning");
});

test("boots in production with ACCESS_PASSWORD set", async () => {
  const { health } = await bootsWith({ NODE_ENV: "production", ACCESS_PASSWORD: "s3cret" });
  assert.equal(health.ok, true);
  assert.equal(health.authRequired, true);
});

test("boots with NODE_ENV unset", async () => {
  const { health } = await bootsWith({ NODE_ENV: undefined, ACCESS_PASSWORD: undefined });
  assert.equal(health.ok, true);
});

test("boots with a malformed numeric env var instead of throwing", async () => {
  const { health } = await bootsWith({
    NODE_ENV: "production",
    ACCESS_PASSWORD: "x",
    MAX_RESPONSE_MB: "not-a-number",
    REQUEST_TIMEOUT_MS: "???",
  });
  assert.equal(health.ok, true);
  assert.ok(health.warnings > 0, "malformed env should produce warnings, not a crash");
});

test("boots when LOG_LEVEL is unusual and logging still works", async () => {
  const { health } = await bootsWith({ LOG_LEVEL: "debug", ACCESS_PASSWORD: "x" });
  assert.equal(health.ok, true);
});
