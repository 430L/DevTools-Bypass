# InSite DevTools Proxy

A self-hosted Node.js development proxy that rewrites proxied HTML so Eruda and an InSite helper run inside the **same browser origin as the proxy app**. This avoids the local-file iframe same-origin problem from the earlier prototype.

## What it includes

- Node.js/Express backend
- URL navigation frontend
- HTML/resource URL rewriting
- Eruda 3.4.3 served locally from npm instead of a CDN
- Eruda Console / Elements / Network / Resources / Sources / Info / Snippets
- InSite floating DevTools shell
- Element picker and computed-style snapshot
- Target-page JavaScript runner
- HTML/text viewer
- Temporary dark-mode CSS override
- Redirect rewriting
- Cookie path isolation per proxied target origin
- CSP/X-Frame-Options policy-header stripping required for the controlled proxy page
- SSRF protections for localhost/private/reserved IPs
- Rate limiting
- Optional host allowlist
- Password-protected deployment
- Bonto-compatible `package.json` and `PORT` handling

## Deploy on Bonto

Bonto supports Node.js 18/20/22, npm dependencies, environment variables, HTTPS and `process.env.PORT`. The project is intended to run as a normal Node.js app.

1. Create a new **Node.js** app in Bonto.
2. Upload this project or copy its files into the app.
3. Set the app's Node version to **20 or 22**.
4. Set the required environment variable:

   `ACCESS_PASSWORD=<long-random-password>`

5. Optionally set:

   `ALLOWED_HOSTS=example.com,developer.mozilla.org`

6. Deploy/start the app. Bonto will install dependencies from `package.json` and provide `PORT`.
7. Open the assigned `https://<your-app>.bonto.run` URL and sign in.

## Important limitations

This is a **development proxy**, not a browser security bypass. Some applications will not work perfectly when proxied because modern web apps can depend on their original origin, complex WebAuthn/OAuth flows, service workers, signed requests, certificate-bound authentication, origin checks, or other browser security features. Do not use it as a way to defeat network or school administrator controls.

The proxy intentionally blocks obvious internal/private targets. A public deployment should keep the password enabled. For a stronger security posture, also configure `ALLOWED_HOSTS`.

## Local run

```bash
npm install
ACCESS_PASSWORD='choose-a-password' npm start
```

Then open `http://localhost:3000`.

## Health check

`GET /healthz` returns a small JSON health response.

## Updating Eruda

Eruda is pinned at **3.4.3** in `package.json`. Update it deliberately and test the proxy rewrite/injection behavior after changing the version.
