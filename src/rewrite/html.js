"use strict";

const cheerio = require("cheerio");
const { cleanTarget, proxyEndpoint, isNonHttp } = require("./url");
const { rewriteCss } = require("./css");
const { rewriteSrcset } = require("./srcset");
const { escapeJsonForScript } = require("../util/html-escape");
const config = require("../config");

// The set of `rel` tokens on <link> that trigger a subresource fetch.
const FETCHING_REL = new Set([
  "stylesheet",
  "preload",
  "modulepreload",
  "icon",
  "shortcut icon",
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
  "apple-touch-startup-image",
  "mask-icon",
  "manifest",
  "prefetch",
  "prerender",
  "dns-prefetch",
  "preconnect",
]);

// Attributes that carry URL-bearing values but whose *fetched resources* are proxied as
// generic /api/resource/ requests.
const RESOURCE_ATTRS = ["src", "poster", "background", "data", "formaction", "cite", "usemap"];

const MAX_SRCDOC_DEPTH = 3;

function rewriteHtml(html, target, depth = 0) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Strip target-page directives that would break the shell.
  $("meta[http-equiv]").each((_, el) => {
    const v = String($(el).attr("http-equiv") || "").toLowerCase();
    if (
      ["content-security-policy", "content-security-policy-report-only", "origin-trial"].includes(v)
    ) {
      $(el).remove();
    } else if (v === "refresh") {
      // <meta http-equiv="refresh" content="0; url=https://target/…">
      const content = String($(el).attr("content") || "");
      const rewritten = rewriteMetaRefresh(content, target.href);
      if (rewritten !== null) $(el).attr("content", rewritten);
    }
  });

  // Simple resource attributes.
  for (const attr of RESOURCE_ATTRS) {
    $(`[${attr}]`).each((_, el) => {
      const raw = $(el).attr(attr);
      if (isNonHttp(raw)) return;
      const u = cleanTarget(raw, target.href);
      if (u) $(el).attr(attr, proxyEndpoint(u, "resource"));
    });
  }

  // Anchor href → resolve to absolute so the client-side srcdoc script can navigate them.
  // (Inside a srcdoc iframe location.href is "about:srcdoc", which breaks relative URLs.)
  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href");
    if (isNonHttp(raw)) return;
    const u = cleanTarget(raw, target.href);
    if (u) $(el).attr("href", u.href);
  });
  // Same for area (image maps) and form actions.
  $("area[href]").each((_, el) => {
    const raw = $(el).attr("href");
    if (isNonHttp(raw)) return;
    const u = cleanTarget(raw, target.href);
    if (u) $(el).attr("href", u.href);
  });
  $("form[action]").each((_, el) => {
    const raw = $(el).attr("action");
    if (isNonHttp(raw)) return;
    const u = cleanTarget(raw, target.href);
    if (u) $(el).attr("action", u.href);
  });

  // Prevent target=_top or target=_parent from escaping the iframe shell.
  $("a[target], area[target], form[target], base[target]").each((_, el) => {
    const t = String($(el).attr("target") || "").toLowerCase();
    if (t === "_top" || t === "_parent") $(el).attr("target", "_self");
  });

  // <link> — only fetching rels go through the resource proxy.
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    if (!Array.from(FETCHING_REL).some((token) => rel.split(/\s+/).includes(token))) return;
    const raw = $(el).attr("href");
    if (isNonHttp(raw)) return;
    const u = cleanTarget(raw, target.href);
    if (u) $(el).attr("href", proxyEndpoint(u, "resource"));
  });

  // srcset.
  $("[srcset]").each((_, el) => {
    $(el).attr("srcset", rewriteSrcset($(el).attr("srcset") || "", target.href));
  });
  // imagesrcset on <link rel="preload" as="image">.
  $("[imagesrcset]").each((_, el) => {
    $(el).attr("imagesrcset", rewriteSrcset($(el).attr("imagesrcset") || "", target.href));
  });

  // SVG resource references.
  $("use, image, script").each((_, el) => {
    const $el = $(el);
    for (const key of ["href", "xlink:href"]) {
      const raw = $el.attr(key);
      if (!raw || isNonHttp(raw)) continue;
      const u = cleanTarget(raw, target.href);
      if (u) $el.attr(key, proxyEndpoint(u, "resource"));
    }
  });

  // Inline <style> and style="..." attributes.
  $("style").each((_, el) => $(el).text(rewriteCss($(el).text(), target.href)));
  $("[style]").each((_, el) =>
    $(el).attr("style", rewriteCss($(el).attr("style") || "", target.href)),
  );

  // <script type="importmap"> — rewrite each specifier target.
  $('script[type="importmap"]').each((_, el) => {
    try {
      const map = JSON.parse($(el).text());
      const rewriteMap = (obj) => {
        if (!obj || typeof obj !== "object") return;
        for (const key of Object.keys(obj)) {
          const val = obj[key];
          if (typeof val === "string") {
            const u = cleanTarget(val, target.href);
            if (u) obj[key] = proxyEndpoint(u, "resource");
          } else if (val && typeof val === "object") {
            rewriteMap(val);
          }
        }
      };
      if (map.imports) rewriteMap(map.imports);
      if (map.scopes) rewriteMap(map.scopes);
      if (map.integrity) map.integrity = {};
      // cheerio.text() does NOT encode </script>. A hostile importmap specifier could
      // otherwise terminate the script tag early — escape the JSON the same way we do
      // for the boot payload.
      $(el).text(escapeJsonForScript(JSON.stringify(map)));
    } catch {
      /* leave malformed importmaps alone */
    }
  });

  // Frames — proxy them as page requests so their contents also get rewritten.
  $("iframe[src], frame[src]").each((_, el) => {
    const raw = $(el).attr("src");
    if (isNonHttp(raw)) return;
    const u = cleanTarget(raw, target.href);
    if (u) $(el).attr("src", proxyEndpoint(u, "page"));
  });

  // iframe[srcdoc] — recursively rewrite the inlined HTML, but cap the depth so
  // a hostile page cannot craft deeply-nested srcdoc trees that blow the V8 stack.
  if (depth < MAX_SRCDOC_DEPTH) {
    $("iframe[srcdoc]").each((_, el) => {
      const inner = $(el).attr("srcdoc");
      if (typeof inner === "string" && inner.trim()) {
        $(el).attr("srcdoc", rewriteHtml(inner, target, depth + 1));
      }
    });
  }

  // SRI hashes will not match the modified bytes; drop them.
  $("[integrity]").each((_, el) => $(el).removeAttr("integrity"));

  // Normalize crossorigin — anonymous keeps CORS honest for proxied assets.
  $("[crossorigin]").each((_, el) => $(el).attr("crossorigin", "anonymous"));

  // <base> is dropped: anchors are now absolute after our rewrite so a base is misleading.
  $("base").remove();

  // Referrer + boot script.
  $("head").prepend('<meta name="referrer" content="no-referrer">');
  injectBoot($, target);

  return $.html();
}

function rewriteMetaRefresh(content, base) {
  // Grammar: N; URL=... or N; url ... (case-insensitive, optional whitespace).
  const m = /^(\s*\d+\s*;\s*url\s*=\s*)(.+)$/i.exec(content);
  if (!m) return null;
  const raw = m[2].trim().replace(/^['"]|['"]$/g, "");
  if (isNonHttp(raw)) return null;
  const u = cleanTarget(raw, base);
  if (!u) return null;
  return `${m[1]}${proxyEndpoint(u, "page")}`;
}

function injectBoot($, target) {
  const payload = escapeJsonForScript(
    JSON.stringify({ target: target.href, origin: target.origin, eruda: config.ERUDA_VERSION }),
  );
  const boot = `
<script>window.__INSITE__=${payload};</script>
<script src="/vendor/eruda.js"></script>
<script src="/insite.js"></script>
<script>
try {
  if (window.eruda && !window.__INSITE_ERUDA_READY__) {
    window.eruda.init({
      tool: ["console","elements","network","resources","sources","info","snippets"],
      useShadowDom: true,
      autoScale: true,
      defaults: { displaySize: 50, transparency: 0.95 }
    });
    window.__INSITE_ERUDA_READY__ = true;
  }
} catch (e) { console.error("[InSite] Eruda init failed", e); }
</script>`;
  if ($("head").length) $("head").append(boot);
  else $("html").prepend(boot);
}

module.exports = { rewriteHtml, rewriteMetaRefresh };
