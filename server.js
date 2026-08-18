const express = require("express");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:false, limit:"2mb"}));

const PORT = Number(process.env.PORT || 3000);
const ACCESS_PASSWORD = String(process.env.ACCESS_PASSWORD || "");
const MAX_RESPONSE_BYTES = Math.max(1, Number(process.env.MAX_RESPONSE_MB || 20)) * 1024 * 1024;
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.REQUEST_TIMEOUT_MS || 20000));
const RATE_WINDOW_MS = Math.max(10000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60000));
const RATE_MAX = Math.max(20, Number(process.env.RATE_LIMIT_MAX || 120));
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_HOSTS || "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean));
const ERUDA_VERSION = "3.4.3";
const ERUDA_PATH = require.resolve("eruda");

const buckets = new Map();

function encodeTarget(url) {
  return Buffer.from(url, "utf8").toString("base64url");
}
function decodeTarget(key) {
  return Buffer.from(key, "base64url").toString("utf8");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function parseCookies(header="") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0,i).trim()] = part.slice(i+1).trim();
  }
  return out;
}
function authToken(password) {
  return crypto.createHmac("sha256", ACCESS_PASSWORD).update(password).digest("hex");
}
function isAuthed(req) {
  if (!ACCESS_PASSWORD) return true;
  const value = parseCookies(req.headers.cookie || "").insite_session || "";
  const expected = authToken(ACCESS_PASSWORD);
  if (value.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
function privateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    return p[0]===10 || p[0]===127 || p[0]===0 || (p[0]===169&&p[1]===254) ||
      (p[0]===172&&p[1]>=16&&p[1]<=31) || (p[0]===192&&p[1]===168) ||
      (p[0]===100&&p[1]>=64&&p[1]<=127) || (p[0]===198&&(p[1]===18||p[1]===19));
  }
  const v = ip.toLowerCase();
  return v==="::1" || v==="::" || v.startsWith("fc") || v.startsWith("fd") ||
    v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}
async function validateTarget(u) {
  if (!["http:","https:"].includes(u.protocol)) throw new Error("Only HTTP and HTTPS targets are supported.");
  const host = u.hostname.toLowerCase();
  if (host==="localhost" || host.endsWith(".localhost") || host==="metadata.google.internal")
    throw new Error("Local and internal targets are blocked.");
  if (ALLOWED_HOSTS.size && ![...ALLOWED_HOSTS].some(h => host===h || host.endsWith("." + h)))
    throw new Error("This hostname is not in ALLOWED_HOSTS.");
  if (net.isIP(host)) {
    if (privateIp(host)) throw new Error("Private or reserved IP targets are blocked.");
    return;
  }
  const answers = await dns.lookup(host, {all:true, verbatim:true});
  if (!answers.length || answers.some(a=>privateIp(a.address)))
    throw new Error("The hostname resolves to a private or reserved address.");
}
function cleanTarget(raw, base) {
  try {
    const u = new URL(raw, base);
    return ["http:","https:"].includes(u.protocol) ? u : null;
  } catch { return null; }
}
function proxyEndpoint(target, kind="resource") {
  const key = encodeTarget(target.href);
  return `/api/${kind}/${key}`;
}
function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (full,q,raw) => {
      if (/^(data:|blob:|javascript:|#)/i.test(raw)) return full;
      const u = cleanTarget(raw, base);
      return u ? `url(${q}${proxyEndpoint(u,"resource")}${q})` : full;
    })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (full,q,raw) => {
      const u = cleanTarget(raw, base);
      return u ? `@import ${q}${proxyEndpoint(u,"resource")}${q}` : full;
    });
}
function rewriteSrcset(raw, base) {
  return raw.split(",").map(part => {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) return part;
    const u = cleanTarget(bits[0], base);
    if (u) bits[0] = proxyEndpoint(u,"resource");
    return bits.join(" ");
  }).join(", ");
}
function injectBoot($, target) {
  const payload = JSON.stringify({ target: target.href, origin: target.origin, eruda: ERUDA_VERSION });
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
function rewriteHtml(html, target) {
  const $ = cheerio.load(html, {decodeEntities:false});

  // Remove target-page policies that are incompatible with the controlled browser shell.
  $("meta[http-equiv]").each((_,el) => {
    const v = String($(el).attr("http-equiv") || "").toLowerCase();
    if (["content-security-policy","content-security-policy-report-only","origin-trial"].includes(v))
      $(el).remove();
  });

  // Resource-bearing attributes go through the backend.
  for (const attr of ["src","poster","background"]) {
    $(`[${attr}]`).each((_,el) => {
      const raw = $(el).attr(attr);
      if (!raw || /^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(raw)) return;
      const u = cleanTarget(raw, target.href);
      if (u) $(el).attr(attr, proxyEndpoint(u,"resource"));
    });
  }

  // Stylesheets/preloads need the resource proxy; normal anchors stay as target URLs,
  // because insite.js intercepts them and routes navigation through the shell.
  $("link[href]").each((_,el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    const raw = $(el).attr("href");
    const u = cleanTarget(raw, target.href);
    if (u && (rel.includes("stylesheet") || rel.includes("preload") || rel.includes("modulepreload")))
      $(el).attr("href", proxyEndpoint(u,"resource"));
  });

  $("[srcset]").each((_,el) => {
    $(el).attr("srcset", rewriteSrcset($(el).attr("srcset") || "", target.href));
  });

  $("style").each((_,el)=>$(el).text(rewriteCss($(el).text(), target.href)));
  $("[style]").each((_,el)=>$(el).attr("style", rewriteCss($(el).attr("style") || "", target.href)));

  // Frames are page-like resources. insite.js can navigate the parent shell instead of
  // allowing an external-origin child to escape the controlled environment.
  $("iframe[src],frame[src]").each((_,el) => {
    const raw=$(el).attr("src"), u=cleanTarget(raw,target.href);
    if(u) $(el).attr("src", proxyEndpoint(u,"page"));
  });

  $("base").remove();
  $("head").prepend('<meta name="referrer" content="no-referrer">');
  injectBoot($, target);
  return $.html();
}
function requestHeaders(req) {
  const out = {};
  const deny = new Set(["host","connection","content-length","accept-encoding","origin","referer"]);
  for (const [k,v] of Object.entries(req.headers)) {
    if (!deny.has(k) && typeof v === "string") out[k] = v;
  }
  out["accept-encoding"] = "identity";
  out["user-agent"] = req.headers["user-agent"] || "Mozilla/5.0 InSiteProxy";
  return out;
}
function cookieRewrite(value, target) {
  if (!value) return null;
  const list = value.split(/,(?=[^;]+?=)/).map(x=>x.trim());
  return list.map(raw => {
    const parts = raw.split(";").map(x=>x.trim());
    const first = parts.shift();
    const kept = [];
    for (const p of parts) {
      const low=p.toLowerCase();
      if (low.startsWith("domain=")) continue;
      if (low.startsWith("path=")) { kept.push("Path=/"); continue; }
      if (low==="samesite=none") { kept.push("SameSite=Lax"); continue; }
      kept.push(p);
    }
    if (!kept.some(p=>/^path=/i.test(p))) kept.push("Path=/");
    return [first,...kept].join("; ");
  });
}
async function fetchUpstream(target, req, body=null) {
  await validateTarget(target);
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const init = {
      method: req.method || "GET",
      headers: requestHeaders(req),
      redirect: "manual",
      signal: controller.signal
    };
    if (body != null && ["POST","PUT","PATCH","DELETE"].includes(init.method)) init.body = body;
    return await fetch(target.href, init);
  } finally {
    clearTimeout(timer);
  }
}
function passHeaders(upstream, res) {
  const blocked = new Set([
    "content-security-policy","content-security-policy-report-only","x-frame-options",
    "cross-origin-opener-policy","cross-origin-embedder-policy","cross-origin-resource-policy",
    "content-length","content-encoding","transfer-encoding","set-cookie"
  ]);
  upstream.headers.forEach((v,k)=>{ if(!blocked.has(k.toLowerCase())) res.setHeader(k,v); });
}
function rateLimit(req,res,next) {
  const ip=req.ip || req.socket.remoteAddress || "unknown";
  const now=Date.now();
  let b=buckets.get(ip);
  if(!b || now-b.start>=RATE_WINDOW_MS) b={start:now,count:0};
  b.count++; buckets.set(ip,b);
  if(b.count>RATE_MAX) return res.status(429).json({error:"Rate limit exceeded. Try again shortly."});
  next();
}

app.get("/healthz", (_req,res)=>res.json({ok:true,node:process.version,eruda:ERUDA_VERSION}));
app.get("/vendor/eruda.js", (_req,res)=>res.type("application/javascript").sendFile(ERUDA_PATH));
app.get("/", (_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.get("/auth/status",(req,res)=>res.json({
  required: !!ACCESS_PASSWORD,
  authenticated: isAuthed(req)
}));
app.post("/auth/login",(req,res)=>{
  if (!ACCESS_PASSWORD) return res.json({ok:true});
  if(String(req.body.password||"") !== ACCESS_PASSWORD)
    return res.status(401).json({ok:false,error:"Invalid password"});
  const token=authToken(ACCESS_PASSWORD);
  res.cookie("insite_session",token,{
    httpOnly:true,sameSite:"lax",secure:!!req.secure,maxAge:7*24*60*60*1000,path:"/"
  });
  res.json({ok:true});
});
app.post("/auth/logout",(req,res)=>{res.clearCookie("insite_session",{path:"/"});res.json({ok:true});});

async function handleProxy(req, res, kind) {
  if (ACCESS_PASSWORD && !isAuthed(req)) return res.status(401).json({error:"Authentication required."});

  // URL-safe base64 is deliberately accepted as a single path segment.
  const prefix = `/api/${kind}/`;
  let encoded = req.originalUrl.split("?",1)[0].slice(prefix.length);
  if (!encoded) return res.status(400).json({error:"Missing encoded target URL."});

  let target;
  try {
    target = new URL(decodeTarget(encoded));
  } catch {
    return res.status(400).json({error:"Invalid target encoding."});
  }

  try {
    const upstream = await fetchUpstream(target, req);
    const status = upstream.status;

    if ([301,302,303,307,308].includes(status)) {
      const loc = upstream.headers.get("location");
      if (!loc) return res.status(status).end();
      const resolved = cleanTarget(loc, target.href);
      if (!resolved) return res.status(502).json({error:"Upstream redirect target is not HTTP(S)."});
      return res.status(200).type("html").send(
        `<script>window.parent.postMessage(${JSON.stringify({type:"insite:navigate",url:resolved.href})},"*")</script>`
      );
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES)
      return res.status(413).send("Upstream response exceeds configured size.");

    const type = upstream.headers.get("content-type") || "";
    passHeaders(upstream,res);
    res.setHeader("cache-control","no-store");
    res.setHeader("x-insite-target",target.href);

    if (kind==="page" || type.includes("text/html")) {
      return res.status(status).type("html").send(rewriteHtml(buf.toString("utf8"),target));
    }
    if (type.includes("text/css") || /\.css(?:$|\?)/i.test(target.pathname)) {
      return res.status(status).type("css").send(rewriteCss(buf.toString("utf8"),target.href));
    }
    if (type.includes("javascript") || type.includes("ecmascript") || /\.(?:m?js)(?:$|\?)/i.test(target.pathname)) {
      let js=buf.toString("utf8");
      js=js.replace(/(\b(?:from|import)\s*["'])([^"']+)(["'])/g,(all,a,b,c)=>{
        const u=cleanTarget(b,target.href); return u ? a+proxyEndpoint(u,"resource")+c : all;
      });
      js=js.replace(/(\bimport\s*\(\s*["'])([^"']+)(["']\s*\))/g,(all,a,b,c)=>{
        const u=cleanTarget(b,target.href); return u ? a+proxyEndpoint(u,"resource")+c : all;
      });
      return res.status(status).type("application/javascript").send(js);
    }
    return res.status(status).end(buf);
  } catch(e) {
    const message=e.name==="AbortError" ? "Upstream request timed out." : e.message;
    console.error(`[InSite] ${req.method} ${target?.href||"?"}: ${message}`);
    return res.status(502).type("html").send(
      `<!doctype html><meta charset="utf-8"><title>InSite Proxy Error</title>`+
      `<style>body{font:15px system-ui;background:#0b1020;color:#e5e7eb;padding:30px}pre{white-space:pre-wrap;background:#111827;padding:14px;border:1px solid #334155;border-radius:8px}a{color:#60a5fa}</style>`+
      `<h1>InSite Proxy Error</h1><p>Target: ${escapeHtml(target?.href||"unknown")}</p><pre>${escapeHtml(message)}</pre><p><a href="/">Return to InSite</a></p>`
    );
  }
}

// Use prefix middleware rather than wildcard/parameter route matching.
// Express 4/5 and Bonto reverse proxies all preserve these prefixes.
app.use("/api/page", rateLimit, (req,res) => handleProxy(req,res,"page"));
app.use("/api/resource", rateLimit, (req,res) => handleProxy(req,res,"resource"));

app.use(express.static(path.join(__dirname,"public"),{extensions:["html"]}));
app.use((req,res,next)=>{
  if (req.path.startsWith("/api/")) return res.status(404).json({error:"InSite API route not found.",path:req.path});
  if (req.method==="GET" || req.method==="HEAD") return res.sendFile(path.join(__dirname,"public","index.html"));
  return res.status(404).send("InSite: route not found.");
});
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:"Internal server error"});});

app.listen(PORT,()=>console.log(`InSite listening on ${PORT}; Eruda ${ERUDA_VERSION}`));
