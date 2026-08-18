"use strict";

const { Transform } = require("node:stream");

class BodySizeLimitError extends Error {
  constructor(limit) {
    super(`Upstream response exceeds size cap (${limit} bytes)`);
    this.name = "BodySizeLimitError";
    this.limit = limit;
    this.statusHint = 413;
  }
}

// A Transform stream that counts bytes and errors out when the cap is exceeded.
// The downstream response is destroyed rather than truncated so the client sees a clean abort.
function limitedTransform(maxBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) return cb(new BodySizeLimitError(maxBytes));
      cb(null, chunk);
    },
  });
}

// Collect a bounded amount of bytes from a readable stream, aborting once the cap is exceeded.
async function collectBounded(readable, maxBytes) {
  const parts = [];
  let seen = 0;
  for await (const chunk of readable) {
    seen += chunk.length;
    if (seen > maxBytes) throw new BodySizeLimitError(maxBytes);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

module.exports = { limitedTransform, collectBounded, BodySizeLimitError };
