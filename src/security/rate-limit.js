"use strict";

// Sliding-window (log-based) limiter. Keyed by req.ip. Small enough for a single
// process; run behind a shared store (Redis) if you scale horizontally.

const SWEEP_INTERVAL_MS = 60 * 1000;

const registries = new Set();

setInterval(() => {
  const now = Date.now();
  for (const reg of registries) {
    for (const [key, log] of reg.map) {
      // Drop entries whose most recent hit is older than the window.
      const last = log[log.length - 1];
      if (last === undefined || now - last > reg.windowMs) reg.map.delete(key);
    }
  }
}, SWEEP_INTERVAL_MS).unref();

function createLimiter({ windowMs, max, name = "api", keyFn }) {
  const reg = { map: new Map(), windowMs, max, name };
  registries.add(reg);

  return function limit(req, res, next) {
    const key = keyFn ? keyFn(req) : req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const log = reg.map.get(key) || [];
    // Trim entries outside the sliding window.
    while (log.length && now - log[0] > windowMs) log.shift();
    if (log.length >= max) {
      const retryMs = windowMs - (now - log[0]);
      res.setHeader("Retry-After", Math.ceil(retryMs / 1000));
      return res.status(429).json({
        error: `Rate limit exceeded (${name}). Try again shortly.`,
      });
    }
    log.push(now);
    reg.map.set(key, log);
    return next();
  };
}

module.exports = { createLimiter };
