const express = require('express');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const { pipeline } = require('stream/promises');
const cheerio = require('cheerio');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 3000);
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const MAX_RESPONSE_BYTES = Math.max(1, Number(process.env.MAX_RESPONSE_MB || 20)) * 1024 * 1024;
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.REQUEST_TIMEOUT_MS || 20000));
const RATE_WINDOW = Math.max(10000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60000));
const RATE_MAX = Math.max(20, Number(process.env.RATE_LIMIT_MAX || 120));
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));

const ERUDA_VERSION = '3.4.3';
const erudaPath = require.resolve('eruda');
const erudaDir = path.dirname(erudaPath);

const rate = new Map();
const sessions = new Map();

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}
function fromB64url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}
function targetKey(origin) { return b64url(origin); }
function cookieParse(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function sessionToken(password) {
  return crypto.createHmac('sha256', ACCESS_PASSWORD).update(password).digest('hex');
}
function isAuthed(req) {
  if (!ACCESS_PASSWORD) return false;
  const c = cookieParse(req.headers.cookie || '');
  const expected = sessionToken(ACCESS_PASSWORD);
  return !!c.insite_session && crypto.timingSafeEqual(Buffer.from(c.insite_session), Buffer.from(expected));
}
function isLoopbackOrPrivate(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
      p[0] === 0 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 198 && p[1] >= 18 && p[1] <= 19) || (p[0] === 198 && p[1] === 51 && p[2] === 100) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}
async function validateTarget(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https targets are supported.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') throw new Error('Local/internal targets are blocked.');
  if (ALLOWED_HOSTS.size && ![...ALLOWED_HOSTS].some(h => host === h || host.endsWith('.' + h))) throw new Error('This host is not on the configured ALLOWED_HOSTS list.');
  if (net.isIP(host)) {
    if (isLoopbackOrPrivate(host)) throw new Error('Private or loopback IP targets are blocked.');
    return;
  }
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  if (!answers.length || answers.some(x => isLoopbackOrPrivate(x.address))) throw new Error('The hostname resolves to a private or reserved address.');
}
function proxiedUrl(target) {
  return `/p/${targetKey(target.origin)}${target.pathname || '/'}${target.search || ''}`;
}
function resolveUrl(raw, base) {
  try { return new URL(raw, base); } catch { return null; }
}
function rewriteCssUrls(css, base) {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, q, raw) => {
    if (/^(?:data:|blob:|javascript:|#)/i.test(raw)) return all;
    const u = resolveUrl(raw, base);
    return u && /^https?:$/.test(u.protocol) ? `url(${q}${proxiedUrl(u)}${q})` : all;
  });
}
function rewriteHtml(html, baseUrl, targetOrigin) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Remove browser-enforced policies that prevent this controlled proxy page from running injected tooling.
  $('meta[http-equiv]').each((_, el) => {
    const value = ($(el).attr('http-equiv') || '').toLowerCase();
    if (['content-security-policy', 'content-security-policy-report-only', 'origin-trial'].includes(value)) $(el).remove();
  });

  const attrs = ['href', 'src', 'action', 'poster', 'cite', 'background', 'formaction'];
  for (const attr of attrs) {
    $(`[${attr}]`).each((_, el) => {
      const raw = $(el).attr(attr);
      if (!raw || /^(?:#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(raw)) return;
      const u = resolveUrl(raw, baseUrl);
      if (u && /^https?:$/.test(u.protocol)) $(el).attr(attr, proxiedUrl(u) + (u.hash || ''));
    });
  }

  $('[srcset]').each((_, el) => {
    const raw = $(el).attr('srcset');
    const rewritten = raw.split(',').map(part => {
      const pieces = part.trim().split(/\s+/);
      const u = resolveUrl(pieces.shift(), baseUrl);
      if (u && /^https?:$/.test(u.protocol)) pieces.unshift(proxiedUrl(u) + (u.hash || ''));
      return pieces.join(' ');
    }).join(', ');
    $(el).attr('srcset', rewritten);
  });

  $('style').each((_, el) => $(el).text(rewriteCssUrls($(el).text(), baseUrl)));
  $('[style]').each((_, el) => $(el).attr('style', rewriteCssUrls($(el).attr('style'), baseUrl)));

  $('base').remove();
  $('head').prepend('<meta name="referrer" content="no-referrer">');

  const boot = `\n<script>window.__INSITE__=${JSON.stringify({ targetOrigin, version: ERUDA_VERSION })};</script>\n<script src="/vendor/eruda.js"></script>\n<script src="/insite.js"></script>\n<script>try{window.eruda.init({tool:'all',useShadowDom:true,autoScale:true,defaults:{displaySize:50,transparency:0.95}})}catch(e){console.error('[InSite] Eruda init failed',e)}</script>\n`;
  if ($('head').length) $('head').append(boot); else $('html').prepend(boot);
  return $.html();
}
function proxyHeaders(req) {
  const skip = new Set(['host','connection','content-length','accept-encoding']);
  const headers = {};
  for (const [k,v] of Object.entries(req.headers)) if (!skip.has(k) && typeof v === 'string') headers[k] = v;
  headers['accept-encoding'] = 'identity';
  return headers;
}
function rewriteSetCookies(setCookies, key) {
  return setCookies.map(raw => {
    const parts = raw.split(';').map(x => x.trim());
    const first = parts.shift();
    const kept = [];
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low.startsWith('domain=')) continue;
      if (low.startsWith('path=')) { kept.push(`Path=/p/${key}/`); continue; }
      if (low === 'samesite=none') { kept.push('SameSite=Lax'); continue; }
      if (low.startsWith('priority=')) continue;
      kept.push(p);
    }
    if (!kept.some(x => /^path=/i.test(x))) kept.push(`Path=/p/${key}/`);
    return [first, ...kept].join('; ');
  });
}
function rewriteLocation(value) {
  return value;
}
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let item = rate.get(ip);
  if (!item || now - item.start >= RATE_WINDOW) item = { start: now, count: 0 };
  item.count++;
  rate.set(ip, item);
  if (item.count > RATE_MAX) return res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.' });
  next();
}

app.get('/healthz', (_req,res) => res.json({ok:true, eruda:ERUDA_VERSION, node:process.version}));
app.get('/vendor/eruda.js', (_req,res) => {
  res.type('application/javascript').sendFile(erudaPath, err => { if (err) res.status(404).end(); });
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/auth', express.urlencoded({ extended: false }));
app.get('/auth/status', (req,res) => res.json({ required: !!ACCESS_PASSWORD, authenticated: ACCESS_PASSWORD ? isAuthed(req) : true }));
app.post('/auth/login', (req,res) => {
  if (!ACCESS_PASSWORD) return res.json({ok:true});
  const password = String(req.body.password || '');
  if (password !== ACCESS_PASSWORD) return res.status(401).json({ok:false,error:'Invalid password'});
  const token = sessionToken(password);
  const secureCookie = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('insite_session', token, { httpOnly:true, sameSite:'lax', secure:secureCookie, maxAge: 7*24*60*60*1000, path:'/' });
  res.json({ok:true});
});
app.post('/auth/logout', (req,res) => { res.clearCookie('insite_session', {path:'/'}); res.json({ok:true}); });

app.all('/p/:key/*splat', rateLimit, async (req,res) => {
  if (ACCESS_PASSWORD && !isAuthed(req)) return res.status(401).json({error:'Authentication required.'});

  let origin;
  try { origin = fromB64url(req.params.key); } catch { return res.status(400).send('Bad target key.'); }
  let base;
  try { base = new URL(origin); } catch { return res.status(400).send('Bad target origin.'); }
  if (!/^https?:$/.test(base.protocol)) return res.status(400).send('Bad target protocol.');

  const rawSplat = req.params.splat || '';
  const splat = Array.isArray(rawSplat) ? rawSplat.join('/') : rawSplat;
  const target = new URL('/' + splat, base);
  for (const [k,v] of Object.entries(req.query)) {
    if (k === '__insite') continue;
    if (Array.isArray(v)) v.forEach(x => target.searchParams.append(k,String(x)));
    else target.searchParams.set(k,String(v));
  }

  try { await validateTarget(target); } catch (e) { return res.status(403).send(`<h1>Blocked target</h1><p>${escapeHtml(e.message)}</p>`); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const bodyMethods = new Set(['POST','PUT','PATCH','DELETE']);
    const init = { method:req.method, headers:proxyHeaders(req), redirect:'manual', signal:controller.signal };
    if (bodyMethods.has(req.method)) init.body = req;
    const upstream = await fetch(target.href, init);
    clearTimeout(timer);

    const headers = {};
    upstream.headers.forEach((v,k) => {
      const low = k.toLowerCase();
      if (['content-security-policy','content-security-policy-report-only','x-frame-options','cross-origin-opener-policy','cross-origin-embedder-policy','cross-origin-resource-policy','content-length','content-encoding'].includes(low)) return;
      headers[k] = v;
    });
    headers['cache-control'] = 'no-store';
    headers['x-insite-target'] = target.href;
    if (upstream.headers.get('set-cookie')) headers['set-cookie'] = rewriteSetCookies(upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [upstream.headers.get('set-cookie')], req.params.key);

    if ([301,302,303,307,308].includes(upstream.status)) {
      const loc = upstream.headers.get('location');
      if (loc) {
        const resolved = new URL(loc, target.href);
        headers.location = proxiedUrl(resolved) + (resolved.hash || '');
      }
    }

    res.status(upstream.status);
    for (const [k,v] of Object.entries(headers)) res.setHeader(k,v);

    const type = upstream.headers.get('content-type') || '';
    if (type.includes('text/html')) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length > MAX_RESPONSE_BYTES) return res.status(413).send('HTML response exceeds configured size limit.');
      const html = rewriteHtml(buf.toString('utf8'), target.href, target.origin);
      return res.send(html);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) return res.status(413).send('Response exceeds configured size limit.');
    return res.end(buf);
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError' ? 'Upstream request timed out.' : `Proxy error: ${err.message}`;
    return res.status(502).send(`<h1>InSite proxy error</h1><pre>${escapeHtml(msg)}</pre>`);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({error:'Internal server error'});
});

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

app.listen(PORT, () => console.log(`InSite listening on ${PORT}; Eruda ${ERUDA_VERSION}`));
