#!/usr/bin/env node
// Static site audit: crawl, link check, SEO, static accessibility and security-header checks.
// Zero dependencies (Node 18+). Usage:
//   node site-audit.js <url> [--out <dir>] [--max 40] [--no-external] [--timeout 15000] [--concurrency 6]
// Writes <out>/findings.json, <out>/crawl.json, <out>/summary.md and prints a one-line JSON summary.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const START = argv.find((a) => /^https?:\/\//.test(a));
if (!START) { console.error('Usage: node site-audit.js <url> [--out dir] [--max 40] [--no-external]'); process.exit(2); }
const OUT = path.resolve(opt('out', 'audit'));
const MAX = Number(opt('max', 40));
const TIMEOUT = Number(opt('timeout', 15000));
const CONC = Number(opt('concurrency', 6));
const EXTERNAL = !argv.includes('--no-external');
const ORIGIN = new URL(START).origin;
const UA = 'Mozilla/5.0 (compatible; QA-Agent/1.0)';
fs.mkdirSync(OUT, { recursive: true });

// ---------- helpers ----------
const fingerprint = (rule, url, tag) => {
  const u = new URL(url);
  const where = u.origin === ORIGIN ? u.pathname : `${u.host}${u.pathname}`;
  return crypto.createHash('sha256').update(`${rule}|${where}|${tag}`.toLowerCase()).digest('hex').slice(0, 10);
};
const pool = async (items, n, fn) => {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
};
const attrs = (s) => {
  const o = {};
  for (const m of s.matchAll(/([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) o[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return o;
};
const textOf = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function get(url, method = 'GET') {
  const chain = [];
  let cur = url;
  const t0 = Date.now();
  for (let i = 0; i <= 6; i++) {
    let res;
    try {
      res = await fetch(cur, { method, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8' } });
    } catch (e) { return { url, finalUrl: cur, status: 0, error: e.cause?.code || e.name || e.message, chain, ms: Date.now() - t0 }; }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { chain.push({ status: res.status, url: cur }); cur = new URL(loc, cur).href; continue; }
    const ct = res.headers.get('content-type') || '';
    let body = '';
    if (method === 'GET' && /html/i.test(ct)) body = (await res.text()).slice(0, 2e6);
    else { try { await res.body?.cancel(); } catch { /* ignore */ } }
    return { url, finalUrl: cur, status: res.status, headers: Object.fromEntries(res.headers), contentType: ct, body, chain, ms: Date.now() - t0 };
  }
  return { url, finalUrl: cur, status: 0, error: 'too many redirects', chain, ms: Date.now() - t0 };
}
async function checkLink(url) {
  let r = await get(url, 'HEAD');
  if (r.status === 0 || [403, 405, 501].includes(r.status)) r = await get(url, 'GET');
  return r;
}

// ---------- findings ----------
const findings = [];
const add = (f) => findings.push({ ...f, fingerprint: fingerprint(f.rule, f.where, f.tag || 'page') });
const SEV = ['critical', 'serious', 'moderate', 'minor'];

// ---------- per-page analysis ----------
function analyze(p) {
  const url = p.finalUrl;
  const raw = p.body.replace(/<!--[\s\S]*?-->/g, '');
  const ld = [...raw.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const doc = raw.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const metas = [...doc.matchAll(/<meta\b([^>]*)>/gi)].map((m) => attrs(m[1]));
  const metaName = (n) => metas.find((m) => (m.name || '').toLowerCase() === n)?.content;
  const metaProp = (n) => metas.find((m) => (m.property || '').toLowerCase() === n)?.content;
  const linkTags = [...doc.matchAll(/<link\b([^>]*)>/gi)].map((m) => attrs(m[1]));
  const htmlTag = attrs((doc.match(/<html\b([^>]*)>/i) || [])[1] || '');
  const title = textOf((doc.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const description = metaName('description');
  const canonical = linkTags.find((l) => (l.rel || '').toLowerCase().split(/\s+/).includes('canonical'))?.href;
  const bodyHtml = (doc.match(/<body\b[\s\S]*<\/body>/i) || [doc])[0];
  const text = textOf(bodyHtml);
  const clientRendered = text.length < 120 && /<div[^>]+id=["'](root|app|__next)["']/i.test(bodyHtml);
  const headings = [...bodyHtml.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ level: Number(m[1]), text: textOf(m[3]) }));
  const where = url;
  const a = (rule, severity, category, evidence, fix, extra = {}) => add({ rule, severity, category, where, evidence, fix, ...extra });

  // document-level
  if (!htmlTag.lang) a('html-has-lang', 'serious', 'a11y', '<html> has no lang attribute', 'Add lang="en" (or the page language) to <html>.', { tag: 'html', wcag: '3.1.1' });
  if (!title) a('document-title', 'serious', 'a11y', 'Page has no <title>', 'Add a unique, descriptive <title>.', { tag: 'title', wcag: '2.4.2' });
  else if (title.length < 10 || title.length > 60) a('seo-title-length', 'minor', 'seo', `Title is ${title.length} characters: "${title.slice(0, 80)}"`, 'Keep titles between 10 and 60 characters.', { tag: 'title' });
  if (!description) a('seo-meta-description', 'moderate', 'seo', 'No meta description', 'Add a 50–160 character meta description.', { tag: 'meta' });
  else if (description.length < 50 || description.length > 160) a('seo-meta-description-length', 'minor', 'seo', `Meta description is ${description.length} characters`, 'Keep meta descriptions between 50 and 160 characters.', { tag: 'meta' });
  if (!canonical) a('seo-canonical', 'minor', 'seo', 'No canonical link', 'Add <link rel="canonical"> pointing to the preferred URL.', { tag: 'link' });
  else {
    const norm = (u) => { try { const x = new URL(u, url); return `${x.origin}${x.pathname.replace(/\/$/, '')}`; } catch { return u; } };
    if (norm(canonical) !== norm(url)) a('seo-canonical-mismatch', 'minor', 'seo', `Canonical ${canonical} differs from ${url}`, 'Confirm the canonical is intended; otherwise point it at this page.', { tag: 'link' });
  }
  const robots = (metaName('robots') || '').toLowerCase();
  if (robots.includes('noindex')) a('seo-noindex', 'serious', 'seo', `meta robots: ${robots}`, 'Remove noindex if this page should appear in search.', { tag: 'meta' });
  const missingOg = ['og:title', 'og:description', 'og:image'].filter((n) => !metaProp(n));
  if (missingOg.length) a('seo-og-tags', 'minor', 'seo', `Missing Open Graph tags: ${missingOg.join(', ')}`, 'Add the missing og: tags for rich link previews.', { tag: 'meta' });
  ld.forEach((j, i) => { try { JSON.parse(j); } catch (e) { a('seo-structured-data', 'moderate', 'seo', `JSON-LD block ${i + 1} is not valid JSON: ${e.message}`, 'Fix the JSON-LD syntax.', { tag: 'script' }); } });
  const vp = metaName('viewport');
  if (!vp) a('viewport-missing', 'moderate', 'a11y', 'No meta viewport', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', { tag: 'meta' });
  else if (/user-scalable\s*=\s*(no|0)/i.test(vp) || /maximum-scale\s*=\s*(0?\.\d+|1(\.0+)?)\b/i.test(vp)) a('meta-viewport', 'serious', 'a11y', `Viewport blocks zoom: ${vp}`, 'Remove user-scalable=no and maximum-scale below 2.', { tag: 'meta', wcag: '1.4.4' });
  if (p.finalUrl.startsWith('https://') && /(?:src|href)=["']http:\/\//i.test(doc.replace(/<a\b[^>]*>/gi, ''))) a('mixed-content', 'serious', 'security', 'Page loads resources over http://', 'Load all resources over https.', { tag: 'page' });
  if (p.body.length > 5e5) a('perf-html-size', 'minor', 'performance', `HTML is ${(p.body.length / 1024).toFixed(0)} KB`, 'Reduce inline data and markup size.', { tag: 'page' });
  if (p.ms > 2000) a('perf-slow-response', 'minor', 'performance', `Response took ${p.ms} ms`, 'Investigate server or cache latency.', { tag: 'page' });

  if (clientRendered) {
    a('client-rendered', 'minor', 'content', 'Almost no content in the HTML: the page is rendered by JavaScript', 'Static checks are limited here; audit this page in a real browser (Playwright or the built-in browser).', { tag: 'page' });
    return { title, description, canonical, lang: htmlTag.lang, h1: [], links: [], clientRendered, words: text.split(' ').length };
  }

  // headings
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length !== 1) a('seo-h1', 'moderate', 'seo', h1s.length ? `${h1s.length} <h1> elements` : 'No <h1>', 'Use exactly one <h1> describing the page.', { tag: 'h1', wcag: '1.3.1' });
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level > headings[i - 1].level + 1) { a('heading-order', 'minor', 'a11y', `h${headings[i - 1].level} "${headings[i - 1].text.slice(0, 40)}" is followed by h${headings[i].level} "${headings[i].text.slice(0, 40)}"`, 'Do not skip heading levels.', { tag: 'h' + headings[i].level, wcag: '1.3.1' }); break; }
  }
  if (!/<main\b|role=["']main["']/i.test(bodyHtml)) a('landmark-one-main', 'moderate', 'a11y', 'No <main> landmark', 'Wrap the primary content in <main>.', { tag: 'main' });

  // images, links, buttons, frames
  const imgs = [...bodyHtml.matchAll(/<img\b([^>]*)>/gi)].map((m) => attrs(m[1]));
  const noAlt = imgs.filter((i) => i.alt === undefined && !/presentation|none/i.test(i.role || ''));
  if (noAlt.length) a('image-alt', 'serious', 'a11y', `${noAlt.length} image(s) without alt, e.g. ${noAlt[0].src || '(no src)'}`, 'Add alt text (or alt="" for decorative images).', { tag: 'img', wcag: '1.1.1' });
  const links = [];
  let emptyLinks = 0;
  const generic = new Set();
  for (const m of bodyHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const at = attrs(m[1]);
    const innerImgAlt = (m[2].match(/<img\b[^>]*\balt=["']([^"']+)["']/i) || [])[1];
    const innerSvgTitle = (m[2].match(/<title>([^<]+)<\/title>/i) || [])[1];
    const name = textOf(m[2]) || at['aria-label'] || at.title || innerImgAlt || innerSvgTitle || '';
    if (at.href !== undefined && !name) emptyLinks++;
    if (/^(click here|here|read more|more|learn more)$/i.test(name)) generic.add(name.toLowerCase());
    if (at.href && !/^(#|mailto:|tel:|javascript:|data:)/i.test(at.href)) { try { const u = new URL(at.href, url); u.hash = ''; if (/^https?:$/.test(u.protocol)) links.push(u.href); } catch { /* bad href */ } }
  }
  if (emptyLinks) a('link-name', 'serious', 'a11y', `${emptyLinks} link(s) without an accessible name`, 'Give each link text, aria-label or an image with alt.', { tag: 'a', wcag: '2.4.4' });
  if (generic.size) a('link-text-generic', 'minor', 'a11y', `Generic link text: ${[...generic].join(', ')}`, 'Use link text that makes sense out of context.', { tag: 'a', wcag: '2.4.4' });
  let emptyButtons = 0;
  for (const m of bodyHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const at = attrs(m[1]);
    if (!(textOf(m[2]) || at['aria-label'] || at['aria-labelledby'] || at.title || (m[2].match(/<img\b[^>]*\balt=["']([^"']+)["']/i) || [])[1])) emptyButtons++;
  }
  if (emptyButtons) a('button-name', 'serious', 'a11y', `${emptyButtons} button(s) without an accessible name`, 'Add visible text or aria-label.', { tag: 'button', wcag: '4.1.2' });
  const frames = [...bodyHtml.matchAll(/<iframe\b([^>]*)>/gi)].map((m) => attrs(m[1])).filter((f) => !f.title && !f['aria-label']);
  if (frames.length) a('frame-title', 'serious', 'a11y', `${frames.length} iframe(s) without a title`, 'Add a title attribute to each iframe.', { tag: 'iframe', wcag: '4.1.2' });
  if (/\btabindex=["']?[1-9]/i.test(bodyHtml)) a('tabindex', 'moderate', 'a11y', 'Positive tabindex found', 'Avoid tabindex greater than 0; rely on DOM order.', { tag: 'page', wcag: '2.4.3' });

  // form controls
  const labelRanges = [...bodyHtml.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)].map((m) => ({ s: m.index, e: m.index + m[0].length, f: attrs(m[1]).for }));
  const forIds = new Set(labelRanges.map((l) => l.f).filter(Boolean));
  const unlabeled = {};
  for (const m of bodyHtml.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const at = attrs(m[2]);
    const type = (at.type || 'text').toLowerCase();
    if (m[1].toLowerCase() === 'input' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    const labelled = at['aria-label'] || at['aria-labelledby'] || at.title || (at.id && forIds.has(at.id)) || labelRanges.some((l) => m.index > l.s && m.index < l.e);
    if (!labelled) (unlabeled[m[1].toLowerCase()] ||= []).push(at.placeholder || at.name || at.id || '(no name)');
  }
  for (const [tag, list] of Object.entries(unlabeled)) {
    a('label', 'serious', 'a11y', `${list.length} <${tag}> without an accessible label, e.g. "${String(list[0]).slice(0, 70)}" (placeholder is not a label)`, 'Add <label for>, aria-label or aria-labelledby.', { tag, wcag: '1.3.1, 3.3.2, 4.1.2' });
  }
  return { title, description, canonical, lang: htmlTag.lang, h1: h1s.map((h) => h.text), links, words: text.split(' ').length };
}

// ---------- main ----------
(async () => {
  const pages = new Map(); // normalized url -> page record
  const queue = [START];
  const seen = new Set([new URL(START).href]);
  const sources = new Map(); // link -> first page(s) that reference it
  const noteSource = (l, from) => { const s = sources.get(l) || []; if (s.length < 3 && !s.includes(from)) s.push(from); sources.set(l, s); };

  // sitemap
  const sitemapUrls = [];
  try {
    const robots = await get(`${ORIGIN}/robots.txt`);
    const sm = [...(robots.status === 200 ? await (await fetch(`${ORIGIN}/robots.txt`)).text() : '').matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]);
    for (const s of sm.length ? sm : [`${ORIGIN}/sitemap.xml`]) {
      const r = await (async () => { try { const res = await fetch(s, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': UA } }); return res.ok ? await res.text() : ''; } catch { return ''; } })();
      for (const m of r.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) sitemapUrls.push(m[1]);
    }
  } catch { /* no sitemap */ }
  for (const u of sitemapUrls) { try { const h = new URL(u).href; if (new URL(h).origin === ORIGIN && !seen.has(h)) { seen.add(h); queue.push(h); } } catch { /* skip */ } }

  // crawl
  while (queue.length && pages.size < MAX) {
    const batch = queue.splice(0, Math.min(CONC, MAX - pages.size));
    const results = await pool(batch, CONC, (u) => get(u));
    for (const [i, r] of results.entries()) {
      const rec = { url: batch[i], finalUrl: r.finalUrl, status: r.status, ms: r.ms, chain: r.chain, error: r.error, headers: r.headers, contentType: r.contentType };
      pages.set(batch[i], rec);
      if (r.status >= 400 || r.status === 0) {
        add({ rule: 'page-error', severity: r.status >= 500 || r.status === 0 ? 'critical' : 'serious', category: 'links', where: r.finalUrl, tag: 'page', evidence: `GET ${batch[i]} returned ${r.status || r.error}`, fix: 'Fix or remove the page and any links to it.' });
        continue;
      }
      if (!/html/i.test(r.contentType || '')) continue;
      if (r.chain.length >= 2) add({ rule: 'link-redirect-chain', severity: 'minor', category: 'links', where: batch[i], tag: 'a', evidence: `${r.chain.length} redirects: ${[...r.chain.map((c) => c.url), r.finalUrl].join(' → ')}`, fix: 'Link directly to the final URL.' });
      Object.assign(rec, analyze({ ...r, url: batch[i] }));
      for (const l of rec.links || []) {
        noteSource(l, rec.finalUrl);
        const isInternalPage = new URL(l).origin === ORIGIN && !/\.(png|jpe?g|gif|svg|webp|ico|css|js|json|xml|pdf|zip|mp4|woff2?|txt)$/i.test(new URL(l).pathname);
        if (isInternalPage && !seen.has(l)) { seen.add(l); queue.push(l); }
      }
    }
  }

  // link check (everything not already crawled)
  const crawled = new Set([...pages.values()].map((p) => p.finalUrl).concat([...pages.keys()]));
  const targets = [...new Set([...sources.keys()])].filter((l) => !crawled.has(l) && (EXTERNAL || new URL(l).origin === ORIGIN));
  let unverifiable = 0;
  const linkResults = await pool(targets, CONC, async (l) => ({ l, r: await checkLink(l) }));
  for (const { l, r } of linkResults) {
    const internal = new URL(l).origin === ORIGIN;
    const from = (sources.get(l) || []).join(', ');
    if ((!internal && [403, 429, 999].includes(r.status)) || (!internal && r.error === 'TimeoutError')) { unverifiable++; continue; }
    if (r.status === 0 || r.status >= 400) {
      add({ rule: 'link-broken', severity: internal ? 'serious' : 'moderate', category: 'links', where: l, tag: 'a', evidence: `${r.status || r.error} for ${l} (linked from ${from})`, fix: 'Update or remove the broken link.' });
    } else if (r.chain.length >= 2) {
      add({ rule: 'link-redirect-chain', severity: 'minor', category: 'links', where: l, tag: 'a', evidence: `${r.chain.length} redirects for ${l} (linked from ${from})`, fix: 'Link directly to the final URL.' });
    }
  }
  // sitemap entries that are not OK or not crawled successfully
  for (const u of sitemapUrls) {
    const rec = pages.get(new URL(u).href);
    if (rec && (rec.status >= 400 || rec.status === 0)) add({ rule: 'sitemap-url-broken', severity: 'moderate', category: 'seo', where: u, tag: 'sitemap', evidence: `Sitemap lists ${u} but it returns ${rec.status || rec.error}`, fix: 'Remove it from sitemap.xml or fix the page.' });
  }

  // cross-page duplicates
  for (const [field, rule] of [['title', 'seo-duplicate-title'], ['description', 'seo-duplicate-description']]) {
    const by = new Map();
    for (const p of pages.values()) if (p[field]) by.set(p[field], [...(by.get(p[field]) || []), p.finalUrl]);
    for (const [v, urls] of by) if (urls.length > 1) add({ rule, severity: 'minor', category: 'seo', where: urls[0], tag: field === 'title' ? 'title' : 'meta', evidence: `${urls.length} pages share the ${field} "${v.slice(0, 60)}": ${urls.slice(0, 4).join(', ')}`, fix: `Make each page's ${field} unique.` });
  }

  // security headers on the start page
  const home = pages.get(new URL(START).href);
  if (home && home.headers) {
    const h = home.headers;
    const missing = [];
    if (START.startsWith('https') && !h['strict-transport-security']) missing.push('Strict-Transport-Security');
    if (!h['x-content-type-options']) missing.push('X-Content-Type-Options');
    if (!h['referrer-policy']) missing.push('Referrer-Policy');
    if (!h['content-security-policy']) missing.push('Content-Security-Policy');
    if (!h['x-frame-options'] && !/frame-ancestors/i.test(h['content-security-policy'] || '')) missing.push('X-Frame-Options or CSP frame-ancestors');
    if (missing.length) add({ rule: 'security-headers', severity: 'minor', category: 'security', where: home.finalUrl, tag: 'page', evidence: `Missing response headers: ${missing.join(', ')}`, fix: 'Add the missing security headers at the CDN or server.' });
  }

  // output
  findings.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || a.rule.localeCompare(b.rule));
  const counts = Object.fromEntries(SEV.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(findings, null, 2));
  fs.writeFileSync(path.join(OUT, 'crawl.json'), JSON.stringify([...pages.values()].map(({ headers, ...p }) => p), null, 2));
  const byRule = new Map();
  for (const f of findings) { const k = `${f.rule}|${f.severity}`; byRule.set(k, [...(byRule.get(k) || []), f]); }
  const md = [`# Site audit: ${START}`, '', `Pages crawled: ${pages.size} (max ${MAX}) · links checked: ${targets.length} · unverifiable external links: ${unverifiable}`,
    `Findings: ${counts.critical} critical, ${counts.serious} serious, ${counts.moderate} moderate, ${counts.minor} minor`, '',
    '| Severity | Rule | Count | Example |', '|---|---|---|---|',
    ...[...byRule.entries()].map(([k, list]) => `| ${list[0].severity} | ${list[0].rule} | ${list.length} | ${list[0].where} |`), '',
    ...(findings.some((f) => f.rule === 'client-rendered') ? ['Note: some pages are JavaScript-rendered; static checks are limited there (see the `client-rendered` findings).', ''] : [])].join('\n');
  fs.writeFileSync(path.join(OUT, 'summary.md'), md);
  console.log(JSON.stringify({ out: OUT, pages: pages.size, linksChecked: targets.length, unverifiableExternal: unverifiable, counts }));
})().catch((e) => { console.error(e); process.exit(1); });
