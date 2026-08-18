# InSite DevTools 3.0

A same-origin development proxy that iframes any HTTP(S) page as `srcdoc`
inside a controlled shell and injects [Eruda](https://github.com/liriliri/eruda)
so you can inspect it end-to-end without a browser extension. Intended for
debugging sites you are authorized to inspect.

## Architecture

```
Browser ──▶ InSite shell (/index.html)
                │
                │  fetch(/api/page/<base64url-target>)
                ▼
            Express router ──▶ SSRF-checked undici fetch ──▶ Target site
                │                                                │
                │              upstream body (streamed)          │
                │◀───────────────────────────────────────────────┘
                ▼
   HTML/CSS/JS rewriter (proxies every URL back through us)
                │
                ▼
        <iframe srcdoc> ── Eruda + insite.js injected
```

- **`/api/page/<enc>`** returns a rewritten page; the shell assigns it to
  `iframe.srcdoc` so the iframe is same-origin with the shell and the shell
  can `postMessage()` DevTools commands into it.
- **`/api/resource/<enc>`** streams any subresource (script/CSS/image/media).
- **`/api/ws/<enc>`** proxies a WebSocket upgrade.
- **`/auth/*`** password-gated session (random 32-byte cookie, server-side
  store, strict rate limiting on login).

## Repository layout

```
src/
├── server.js             HTTP + WS bootstrap, route wiring, graceful shutdown
├── config.js             validated env module
├── logger.js             pino with credential + cookie redaction
├── security/
│   ├── ssrf.js           IP normalization, private-range checks, DNS pinning
│   ├── auth.js           sessions, timing-safe compare, cookie flags
│   └── rate-limit.js     sliding-window limiter (per-route)
├── proxy/
│   ├── fetch.js          undici fetch with pinned Agent
│   ├── headers.js        request/response header allow/deny lists
│   ├── cookies.js        per-session per-target tough-cookie jar
│   ├── redirects.js      3xx Location rewrite
│   ├── websocket.js      WS upgrade proxy
│   └── handler.js        streaming page/resource routes
├── rewrite/
│   ├── url.js            encode/decode + cleanTarget
│   ├── srcset.js         paren-aware srcset splitter
│   ├── css.js            handwritten scanner for url()/@import/image-set/…
│   ├── js.js             AST rewrite (meriyah + magic-string) of ES modules
│   └── html.js           exhaustive cheerio pass — meta refresh, importmap, SRI, srcdoc, …
└── util/
    ├── html-escape.js
    └── streams.js        limitedTransform / collectBounded

public/
├── index.html            a11y-labelled shell (topbar, sidebar, drawer)
├── app.js                shell logic: navigation, history, keyboard shortcuts
├── insite.js             injected into the srcdoc iframe
├── styles.css            dark + light theme via prefers-color-scheme
├── favicon.svg
└── manifest.webmanifest

test/                     node:test units for every rewrite + security module
```

## Getting started

```sh
npm ci
npm start
```

Configuration comes from **real environment variables** — set them in your hosting
platform's dashboard, or inline for local runs:

```sh
ACCESS_PASSWORD='a long random string' npm start
```

There is deliberately no `.env` file loading. `.env.example` is a documented list of
the variable names, not a file the app reads.

Development watch mode:

```sh
npm run dev
```

Tests and lint:

```sh
npm test
npm run lint
```

Health check: `curl http://localhost:3000/healthz`

## Environment

**Every variable is optional and the server always starts.** A misconfiguration is
reported as a startup warning in the logs, never as a crash — a process that dies at
boot reaches users as an unexplained `502` from the platform's edge, with nothing to
debug. Set `ACCESS_PASSWORD` in production: without it the proxy runs **open** to
anyone who can reach the URL, and logs a prominent warning saying so on every start.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port. Bound on `0.0.0.0`. |
| `ACCESS_PASSWORD` | *(empty)* | Strongly recommended in production. Empty = open access + startup warning. |
| `ALLOWED_HOSTS` | *(any public host)* | Comma-separated hostname allowlist (matches subdomains). |
| `MAX_RESPONSE_MB` | `25` | Upstream response cap; the stream is aborted mid-flight if exceeded. |
| `MAX_REQUEST_MB` | `25` | Request-body cap for uploads through `/api/*`. |
| `REQUEST_TIMEOUT_MS` | `20000` | Upstream fetch timeout. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding-window size on `/api/*`. |
| `RATE_LIMIT_MAX` | `120` | Max requests per window per IP on `/api/*`. |
| `AUTH_RATE_WINDOW_MS` | `900000` | Sliding-window size on `/auth/login`. |
| `AUTH_RATE_MAX` | `5` | Max failed logins per window per IP. |
| `SESSION_TTL_MS` | 7 days | How long an auth cookie is valid. |
| `SESSION_SECRET` | *(random each boot)* | Set to survive restarts / to share across multiple instances. |
| `TRUST_PROXY_HOPS` | `1` | Number of trusted reverse-proxy hops (for `req.ip`). |
| `LOG_LEVEL` | `info` | pino level. |
| `NODE_ENV` | `development` | `production` forces the auth cookie's `Secure` flag. |
| `ALLOW_PRIVATE_TARGETS` | `false` | **Testing only.** Disables the private/loopback half of the SSRF guard so the integration suite can proxy a local fixture. Never enable this on a deployment. |

## Troubleshooting

**The page shows a `502 Bad gateway` from Cloudflare (or your host), not an
"InSite Proxy Error" page.**
That 502 is generated by the edge, which means the Node process is not reachable —
it is not a proxy problem. Check the platform logs for the startup line:

```
InSite listening {"port":...,"env":"production","authRequired":true}
```

If it is missing, the process died before binding. A `FATAL during startup` banner in
the logs names the reason. The server is designed to start under any configuration, so
a missing startup line means a crash, a wrong start command, or a failed build/install.

**Verifying a deployment:** `curl https://<your-host>/healthz` returns
`{"ok":true,...,"authRequired":<bool>,"warnings":<count>}`. A non-zero `warnings`
count means startup warnings were logged — check them.

**Proxied pages render but look broken.** Some sites cannot be proxied faithfully; see
[Compatibility limits](#compatibility-limits).

## What changed vs 2.x

- **Correctness**
  - POST/PUT/PATCH bodies actually reach the upstream now (`express.raw` is
    mounted on `/api/*` after `express.json` skips those paths).
  - `Set-Cookie` from upstream is stored in a per-session per-target
    `tough-cookie` jar so proxied sites keep their sessions across
    navigations.
  - Relative anchor `href`s are absolutized server-side so they no longer
    resolve against `about:srcdoc` and 404.
  - All 3xx redirects forward the status verbatim with a rewritten `Location`
    header — no more inline `postMessage("*")` shim.
  - Responses stream through a size-capped Transform instead of being fully
    buffered; the stream is aborted mid-flight when the cap is exceeded.
  - WebSocket upgrades are proxied through `/api/ws/<enc>`. `public/insite.js`
    patches `window.WebSocket` inside the frame so a target page's `ws://` /
    `wss://` connections are rewritten onto that endpoint automatically.

- **Security**
  - SSRF: IPv4-mapped IPv6 (`::ffff:*`) is normalized and re-checked.
    Multicast/reserved/CGNAT ranges added. Internal TLDs
    (`.internal`/`.local`/`.consul`/…) blocked. DNS rebinding is closed off
    by resolving once and pinning the IP through a custom `undici.Agent`.
  - The client's `Cookie`/`Authorization` headers are NEVER forwarded to
    targets — target cookies come from the per-session jar instead.
  - Session cookie is a random 32-byte value with a server-side store and
    TTL, replacing the previous static `HMAC(pw, pw)` value.
  - `/auth/login` uses `crypto.timingSafeEqual` and is rate-limited with a
    5-per-15-minute per-IP cap.
  - Response header denylist expanded to strip HSTS, HPKP, Expect-CT,
    Clear-Site-Data, Permissions-Policy, Referrer-Policy, and friends so
    target-page directives cannot pin/lock the proxy hostname.
  - JSON payloads inside `<script>` are escape-sanitized against
    `</script>`, `<!--`, and U+2028/U+2029 breakout.
  - The `x-insite-target` echo header is gone.

- **Rewriter coverage**
  - `<meta http-equiv=refresh>` is rewritten through the proxy.
  - `<iframe srcdoc>` is recursively rewritten.
  - `<script type="importmap">` specifiers are rewritten.
  - SVG `<use xlink:href>`, `<image href>`, `<object data>`, `formaction`,
    `cite`, `usemap`, `imagesrcset` all covered.
  - Every fetching `link[rel]` (icon, manifest, prefetch, dns-prefetch,
    preconnect, apple-touch-icon, mask-icon, …) is proxied.
  - CSS scanner handles quoted/unquoted `url()`, `@import url()`,
    `image-set()`, `cursor: url()`, escapes in string values.
  - `srcset` splitter is paren-aware — comma-bearing `data:` URIs are no
    longer chopped in half.
  - JS module rewrite is AST-based (meriyah + magic-string), so specifiers
    inside comments and strings are left alone.
  - `integrity` attributes are stripped (rewritten bodies won't match the
    hash); `crossorigin` is normalized to `anonymous`; `<base>` is removed;
    anchor `target=_top|_parent` is coerced to `_self`.

- **Frontend**
  - Auth-first boot (no more login-modal race against the default page).
  - AbortController timeout, bounded error text, spinner overlay.
  - Keyboard shortcuts: `Ctrl/Cmd+L`, `Alt+←/→`, `Ctrl/Cmd+R`, `F12`.
  - History persisted in `localStorage`, capped at 100 entries, with a
    "Clear history" button.
  - `insite.js` resolves relative URLs against the real target URL, handles
    middle-click / modifier-key clicks, respects the `download` attribute,
    lets same-origin same-pathname anchor clicks reach SPA routers, and
    hooks `pushState`/`replaceState` to keep the shell URL bar in sync.
  - Accessibility: labelled inputs, `aria-label` on icon buttons,
    skip-to-content link, `:focus-visible` outlines, `prefers-reduced-motion`
    and `prefers-color-scheme: light` support, print stylesheet.

- **Ops**
  - Modular tree under `src/`; no more single-file 344-liner.
  - `pino` structured logs with cookie/authorization/URL-credential
    redaction.
  - Graceful `SIGTERM`/`SIGINT` shutdown.
  - `helmet` hardening on the shell only (`Referrer-Policy`, `nosniff`,
    `X-Frame-Options`) — deliberately **no CSP**. `srcdoc` iframes inherit the
    embedding document's policy, so any CSP set here would silently govern every
    proxied page and break inline handlers, `eval`-based frameworks and runtime
    `fetch()`. Proxy responses carry no helmet headers at all.
  - The server starts under **every** configuration; problems surface as startup
    warnings. Boot-phase crashes exit non-zero (so the platform restarts and
    reports them); post-listen errors are logged without killing the server.
  - CI matrix on Node 20 and 22 (`npm ci` → lint → test).
  - Committed lockfile, `.gitignore`, `LICENSE`, `biome.json`, GitHub Actions
    workflow.

## Compatibility limits

The following will not work through the proxy, by design or by absence of
browser cooperation:

- WebAuthn, hardware-key attestation, certificate-bound authentication.
- Service workers (registration is intentionally not rewritten).
- OAuth flows that require the exact origin registered with the provider.
- Fingerprint-strict CDN protection (Cloudflare Turnstile / Akamai / etc.).
- Native platform features (camera, sensors) if the target relies on strict
  Permissions-Policy — the header is stripped, so the shell's default policy
  applies.

## Development notes

- The public-network smoke test needs outbound HTTPS; the sandboxed CI does
  not have it, so the E2E tests focus on rewriter correctness and the SSRF
  refusal path.
- The DevTools-detection countermeasure surface is **passive**: Eruda is
  injected, but the shell does not attempt to spoof
  `window.top`/`outerWidth`/`console`/`Function.prototype.toString`/…
  against target-side detectors. Adding those is a natural next step.

## License

MIT — see [LICENSE](./LICENSE).
