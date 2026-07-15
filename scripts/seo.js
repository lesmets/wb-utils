#!/usr/bin/env node
// Generate robots.txt + sitemap.xml + llms.txt for every root (each tool + the
// directory).
//
// Each subdomain/domain is its own site to search engines, so every root gets
// its own robots.txt and sitemap.xml keyed to that host's canonical URL (read
// from the <link rel="canonical"> in its index.html - the single source of
// truth). Tool sitemaps list just their one URL today; the directory sitemap
// lists every tool URL, making it the suite's crawl hub. Guide/locale URLs get
// added here as they appear.
//
// llms.txt (llmstxt.org) is the same idea aimed at AI answer engines: a plain
// markdown brief a model can cite without executing our JS. Nothing in it is
// new content - it is projected from what each page already states in its
// JSON-LD (WebApplication + FAQPage) and, for the directory, its category
// sections. Writing it by hand would guarantee drift; generating it means the
// brief is stale only if the page is, and --check proves it mechanically.
//
// Usage:
//   node scripts/seo.js          write robots.txt + sitemap.xml + llms.txt
//   node scripts/seo.js --check  exit 1 if any file is missing or out of date

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECK = process.argv.includes('--check');

// The directory page (repo root) plus one entry per tool directory.
const roots = ['.'].concat(
  fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'index.html')))
    .map(d => d.name)
    .sort()
);
const tools = roots.filter(d => d !== '.');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const sources = new Map();
function html(dir) {
  if (!sources.has(dir)) {
    sources.set(dir, fs.readFileSync(path.join(ROOT, dir, 'index.html'), 'utf8'));
  }
  return sources.get(dir);
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Page text is HTML-escaped; llms.txt is plain markdown and wants the real
// characters ("Color Converter & Picker", not "&amp;").
function decode(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, ref) => {
    if (ref[0] !== '#') return NAMED[ref.toLowerCase()] ?? m;
    const hex = ref[1] === 'x' || ref[1] === 'X';
    return String.fromCodePoint(parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

function canonical(dir) {
  const m = html(dir).match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
  if (!m) fail(`No canonical URL in ${path.join(dir, 'index.html')}`);
  // Normalize to a trailing slash so URLs match the served path exactly.
  return m[1].replace(/\/?$/, '/');
}

// Every application/ld+json block on a page, parsed.
function jsonld(dir) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  for (const m of html(dir).matchAll(re)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch (e) {
      fail(`Invalid JSON-LD in ${path.join(dir, 'index.html')}: ${e.message}`);
    }
  }
  return out;
}

function ldType(dir, type) {
  const block = jsonld(dir).find(b => b['@type'] === type);
  if (!block) fail(`No ${type} JSON-LD in ${path.join(dir, 'index.html')}`);
  return block;
}

// Map every root to its canonical base URL up front so the directory sitemap
// can list every tool URL on its own site.
const base = new Map(roots.map(dir => [dir, canonical(dir)]));

// A sitemap may only list URLs on the site that serves it. Search Console
// rejects a sitemap containing anything outside the property, so a tool that
// has graduated to its exact-match domain (wbwordcounter.com) cannot ride in
// the directory's sitemap at wbest.app - the whole file is refused, not just
// the stray URL. A Domain property covers its subdomains, so *.wbest.app URLs
// are fine there; a different registrable domain never is. Graduated tools are
// not orphaned: each serves its own robots.txt + sitemap.xml from its own host
// and is registered as its own property, and the directory still links to it.
//
// This is enforced here rather than written down anywhere, because seo.js
// projects sitemaps from canonicals on every run: deleting the stray URL by
// hand only survives until the next generate, and now fails `seo.js --check`
// as drift in between.
function sameSite(url, siteHost) {
  const host = new URL(url).host;
  return host === siteHost || host.endsWith(`.${siteHost}`);
}

const offSite = roots.filter(dir => !sameSite(base.get(dir), new URL(base.get('.')).host));

// The directory page groups tools into category sections; read them back so
// llms.txt inherits the same categories, one-line descriptions, and order the
// directory shows.
function cards() {
  const sections = html('.').split(/<h3 class="cat-title"[^>]*>/).slice(1);
  if (!sections.length) fail('No <h3 class="cat-title"> sections in index.html');
  const entries = [];
  for (const section of sections) {
    const category = decode(section.slice(0, section.indexOf('</h3>')).trim());
    for (const [, card] of section.matchAll(/<article class="tool card">([\s\S]*?)<\/article>/g)) {
      const link = card.match(/<h3><a href="([^"]+)">([\s\S]*?)<\/a><\/h3>/);
      const desc = card.match(/<p class="desc">([\s\S]*?)<\/p>/);
      if (!link || !desc) fail(`Unparsable tool card under "${category}" in index.html`);
      entries.push({
        category,
        url: link[1].replace(/\/?$/, '/'),
        desc: decode(desc[1].trim().replace(/\s+/g, ' ')),
      });
    }
  }
  return entries;
}

// Names come from the directory's ItemList JSON-LD rather than the card's link
// text: same name, but structured data is the declaration, not the label.
function itemListNames() {
  const graph = jsonld('.')[0]['@graph'];
  const list = graph && graph.find(n => n['@type'] === 'ItemList');
  if (!list) fail('No ItemList JSON-LD in index.html');
  return new Map(list.itemListElement.map(e => [e.item.url.replace(/\/?$/, '/'), e.item.name]));
}

const named = itemListNames();
const listed = cards().map(e => ({ ...e, name: named.get(e.url) }));
const byUrl = new Map(listed.map(e => [e.url, e]));

// A brief is only as trustworthy as the agreement between the three places a
// tool is declared: its own canonical, its directory card, and the ItemList.
// A tool missing from any of them is exactly the orphan §3's "definition of
// shipped" rules out - catch it here rather than in a crawler.
const canonicals = new Set(tools.map(d => base.get(d)));
const problems = [
  ...tools.filter(d => !byUrl.has(base.get(d)))
    .map(d => `${d} (${base.get(d)}): no directory card in index.html`),
  ...listed.filter(e => !canonicals.has(e.url))
    .map(e => `${e.url}: directory card points at a URL no tool root serves`),
  ...listed.filter(e => canonicals.has(e.url) && !e.name)
    .map(e => `${e.url}: no matching item in the directory's ItemList JSON-LD`),
];
if (problems.length) {
  fail(
    'Directory is out of step with the tools it lists:\n  ' + problems.join('\n  ') +
    '\nEvery shipped tool needs its directory entry, ItemList item, and footer links.'
  );
}

function robots(dir) {
  const origin = new URL(base.get(dir)).origin;
  return [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

// Locale pages generated by translate.js live in subdirectories of a tool
// root (wordcounter/de/, …); each carries its own canonical, which is the
// source of truth here just as the English page's is.
function localeUrls(dir) {
  if (dir === '.') return [];
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(ROOT, dir, d.name, 'index.html')))
    .map(d => canonical(path.join(dir, d.name)))
    .sort();
}

function sitemap(dir) {
  // Directory root lists itself + every tool; a tool lists itself + locales.
  // Anything off this root's own site is dropped (see sameSite): Search Console
  // refuses the entire sitemap over one foreign URL.
  const siteHost = new URL(base.get(dir)).host;
  const urls = (dir === '.'
    ? roots.map(d => base.get(d))
    : [base.get(dir), ...localeUrls(dir)]
  ).filter(u => sameSite(u, siteHost));
  const entries = urls.map(u => `  <url>\n    <loc>${u}</loc>\n  </url>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries,
    '</urlset>',
    '',
  ].join('\n');
}

// The suite-wide promises, stated once. Every brief repeats them because each
// one is fetched on its own and cited on its own.
const PRINCIPLES = [
  'Free to use: no sign-up, no account, no usage limits, no watermarks, no ads.',
  'Private by construction: everything is computed in your browser, so your data is never uploaded, logged, or shared.',
  'Works offline once the page has loaded, and needs no install.',
  'One self-contained page: no cookies, no tracking, no consent popups.',
];

// Link lists always sit under a WBest heading, so they use the plain name the
// directory shows. A tool's own brief is different: it is fetched and cited on
// its own, where "Timer" names a utility but not a product. The suite states the
// branded name in each tool's <title>, so build it from the convention and
// assert the page actually attests it - a retitled page then fails here instead
// of shipping a brief that misnames the tool.
function brandName(dir, name) {
  const brand = `WBest ${name}`;
  const m = html(dir).match(/<title>([\s\S]*?)<\/title>/i);
  if (!m) fail(`No <title> in ${path.join(dir, 'index.html')}`);
  const title = decode(m[1].trim());
  if (!title.includes(brand)) {
    fail(`${path.join(dir, 'index.html')}: <title> does not attest the name "${brand}"\n  title: ${title}`);
  }
  return brand;
}

function faqSection(dir) {
  const questions = ldType(dir, 'FAQPage').mainEntity;
  return questions.flatMap(q => [`### ${q.name}`, '', q.acceptedAnswer.text, '']);
}

// A tool's brief: what it is, what it does, and the answers it already gives
// on-page - the citable facts, minus the interface.
function llmsTool(dir) {
  const app = ldType(dir, 'WebApplication');
  const entry = byUrl.get(base.get(dir));
  const siblings = listed.filter(e => e.category === entry.category && e.url !== entry.url);
  return [
    `# ${brandName(dir, entry.name)}`,
    '',
    `> ${app.description}`,
    '',
    `Use it at ${entry.url}. It is a single page, and the tool is the page.`,
    '',
    ...PRINCIPLES.map(p => `- ${p}`),
    '',
    '## Features',
    '',
    ...app.featureList.map(f => `- ${f}`),
    '',
    '## Frequently asked questions',
    '',
    ...faqSection(dir),
    '## More WB tools',
    '',
    ...siblings.map(e => `- [${e.name}](${e.url}): ${e.desc}`),
    `- [WBest](${base.get('.')}): all ${tools.length} free WB tools, private, no sign-up, no uploads.`,
    '',
  ].join('\n');
}

// The directory's brief: the whole catalog in one fetch, grouped the way the
// directory groups it.
function llmsDirectory() {
  const site = jsonld('.')[0]['@graph'].find(n => n['@type'] === 'WebSite');
  const lines = [
    '# WBest',
    '',
    `> ${site.description}`,
    '',
    `WBest is a suite of ${tools.length} single-purpose online tools, each on its own page and its own domain.`,
    '',
    ...PRINCIPLES.map(p => `- ${p}`),
    '',
  ];
  for (const category of [...new Set(listed.map(e => e.category))]) {
    lines.push(`## ${category}`, '');
    for (const e of listed.filter(x => x.category === category)) {
      lines.push(`- [${e.name}](${e.url}): ${e.desc}`);
    }
    lines.push('');
  }
  lines.push('## Frequently asked questions', '', ...faqSection('.'));
  return lines.join('\n');
}

function llms(dir) {
  return dir === '.' ? llmsDirectory() : llmsTool(dir);
}

let stale = [];
for (const dir of roots) {
  for (const [name, content] of [['robots.txt', robots(dir)], ['sitemap.xml', sitemap(dir)], ['llms.txt', llms(dir)]]) {
    const file = path.join(ROOT, dir, name);
    const rel = path.join(dir === '.' ? '' : dir, name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current !== content) {
      stale.push(rel);
      if (!CHECK) {
        fs.writeFileSync(file, content);
        console.log(`wrote ${rel}`);
      }
    }
  }
}

// Say so out loud: a tool silently missing from the crawl hub is worse than one
// that is listed and rejected, because nothing ever surfaces it again.
if (!CHECK && offSite.length) {
  console.log(
    `Not in the directory sitemap (own domain, own Search Console property): ${offSite.map(d => base.get(d)).join(', ')}`
  );
}

if (CHECK) {
  if (stale.length) {
    console.error('Out of date:\n  ' + stale.join('\n  ') + '\nRun: node scripts/seo.js');
    process.exit(1);
  }
  console.log(`All ${roots.length} roots have current robots.txt + sitemap.xml + llms.txt.`);
} else if (!stale.length) {
  console.log(`All ${roots.length} roots already current.`);
}
