# InSite DevTools 2.0 — Bonto deployment

This version removes the fragile `/p/<target>` iframe architecture from the previous build.

## Architecture

The browser shell is the normal Bonto app page.

1. The frontend requests `/api/page/<encoded-target>`.
2. The server fetches the target.
3. HTML is rewritten so resources are fetched through `/api/resource/<encoded-target>`.
4. Eruda 3.4.3 and `insite.js` are injected into the returned HTML.
5. The result is assigned to an iframe `srcdoc`.
6. Because `srcdoc` is same-origin with the Bonto shell, the shell can communicate with the injected DevTools without cross-origin iframe errors.

This specifically avoids making the browser navigate to `/p/...`, which was the source of the Bonto loading/route problem in the previous version.

## Bonto

Use a Node.js app with Node 20 or 22. Bonto provides `PORT`; `server.js` uses `process.env.PORT`.

Required in production:

`ACCESS_PASSWORD=<long random value>`

Optionally set `ALLOWED_HOSTS=example.com,developer.mozilla.org`.

Run:

`npm install`
`npm start`

Health check:

`/healthz`

## What is included

- URL navigation, back, forward, reload
- Same-origin iframe/srcdoc browser shell
- Server-side target fetching
- HTML rewriting
- CSS URL and @import rewriting
- JS module/import rewriting for common static imports
- Image/script/stylesheet/preload/font/resource proxying
- Anchor navigation routed back through the shell
- GET form navigation
- Eruda 3.4.3 local asset
- Console, Elements, Network, Resources, Sources, Info, Snippets
- Element picker
- Computed-style snapshot
- JavaScript execution
- HTML and text inspection
- Dark override
- Authentication
- Rate limiting
- SSRF protections
- Host allowlisting
- Size and timeout limits

## Important compatibility limits

Some modern applications cannot be perfectly proxied because they depend on original-origin semantics, service workers, WebAuthn, OAuth, certificate-bound authentication, signed requests, strict origin checks, or browser-level features. This project does not bypass those security mechanisms.

It is intended for legitimate debugging of sites you are authorized to inspect.
