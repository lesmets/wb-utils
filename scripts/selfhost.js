#!/usr/bin/env node
// Generate the self-host packager's bare tool templates + manifest.
//
// The packager (selfhost/) lets a team download a rebranded, self-hostable
// copy of selected tools. Tools live on separate subdomains, so the packager
// cannot fetch live pages cross-origin; instead this script pre-builds, for
// every tool x locale, a stripped template the packager fetches same-origin:
//
//   selfhost/templates/<tool>.<lang>.html   bare page, {{...}} placeholders
//   selfhost/templates/root.<lang>.html     package landing-page skeleton
//   selfhost/templates/manifest.json        tool names/descs/icons/sizes
//
// "Bare" means: no SEO (canonical, robots, og/twitter, JSON-LD, hreflang),
// no marketing (tagline, badge, repo link, toc, cross-links, props, prose,
// FAQ) - just the <style>, the <section id="tool">, the app scripts, and a
// skeleton header/footer. Branding is parameterized, substituted client-side:
//
//   {{BRAND_NAME}}           company name (goes into <title> and <h1>)
//   {{LOGO}}                 optional header <img class="brand-logo">
//   {{ACCENT}} {{ACCENT_SOFT}} {{ACCENT_DARK}} {{ACCENT_SOFT_DARK}}
//                            the four wb:base accent colors, everywhere they
//                            appear (CSS and JS alike)
//   {{LANG_SWITCH}}          footer language dropdown with relative links
//   {{FOOTER_ATTRIBUTION}}   localized "Thank you for using WBest Tools"
//
// Placeholders instead of baked defaults so substitution is unambiguous and
// --check can assert zero leftover brand/color literals in any template.
// Templates are generated from the locale pages translate.js writes, so run
// order is sync.js -> translate.js -> selfhost.js -> seo.js.
//
// Usage:
//   node scripts/selfhost.js          rewrite templates + manifest
//   node scripts/selfhost.js --check  exit 1 on drift or failed assertions

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join('selfhost', 'templates');
const CHECK = process.argv.includes('--check');

// Localized strings the packager stamps into every generated page. A locale
// without an entry here fails the build: adding a language to the site forces
// deciding its attribution line too. Endonyms mirror translate.js LANG_NAMES.
const ATTRIBUTION = {
  en: 'Thank you for using <a href="https://wbest.app/">WBest Tools</a>.',
  de: 'Vielen Dank für die Nutzung von <a href="https://wbest.app/">WBest Tools</a>.',
};
const TOOLS_WORD = { en: 'Tools', de: 'Tools' };
const LANG_NAMES = { en: 'English', de: 'Deutsch' };

// The four wb:base accent literals, in both color schemes.
const COLORS = [
  [/#2563eb/gi, '{{ACCENT}}'],
  [/#e8effd/gi, '{{ACCENT_SOFT}}'],
  [/#60a5fa/gi, '{{ACCENT_DARK}}'],
  [/#1c2a44/gi, '{{ACCENT_SOFT_DARK}}'],
];

// Landing-page card styles, a subset of the directory's (wbest/index.html).
const LANDING_CSS = `.tools{display:flex;flex-direction:column;gap:10px;margin:18px auto 34px;max-width:52rem}
.tool{position:relative;display:flex;align-items:center;gap:14px;padding:14px 16px}
.tool:hover{border-color:var(--accent)}
.tool-icon{width:40px;height:40px;border-radius:9px;flex:none}
.tool-body{flex:1;min-width:0}
.tool h3{margin:0;font-size:1.05rem;letter-spacing:-.01em}
.tool h3 a{text-decoration:none;color:var(--text)}
.tool h3 a::after{content:"";position:absolute;inset:0}
.tool:hover h3 a{color:var(--accent)}
.tool .desc{margin:2px 0 0;font-size:.9rem;color:var(--muted)}
.tool .go{color:var(--muted);font-size:1.15rem;flex:none}
.tool:hover .go{color:var(--accent)}`;
const LOGO_CSS = '.brand-logo{height:56px;max-width:220px;object-fit:contain;display:block;margin:24px auto 0}';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function extract(src, re, what, where) {
  const m = re.exec(src);
  if (!m) fail(`Cannot find ${what} in ${where}`);
  return m;
}

// Strip generator-owned marker comments; the template is a final artifact.
function stripMarkers(s) {
  return s.replace(/[ \t]*\/\* (?:wb:[a-z0-9-]+|i18n:js):(?:start|end) \*\/\n?/g, '');
}

function placeholderColors(s) {
  for (const [re, ph] of COLORS) s = s.replace(re, ph);
  return s;
}

// --- template generation --------------------------------------------------

function buildTemplate(dir, lang, src) {
  const where = lang === 'en' ? `${dir}/index.html` : `${dir}/${lang}/index.html`;
  const name = extract(src, /<h1>WBest ([^<]+)<\/h1>/, '<h1>WBest ...</h1>', where)[1];
  const style = extract(src, /<style>[\s\S]*?<\/style>/, '<style> block', where)[0];
  // Keep every non-marketing <section> in <main>: #tool always, plus any
  // extra app section (colorconverter's #palette, timezoneconverter's
  // #planner). Marketing sections carry a prose/props/faq class.
  const mainInner = extract(src, /<main class="wrap">([\s\S]*?)<\/main>/, '<main>', where)[1];
  const sections = [];
  let dropped = mainInner;
  for (const m of mainInner.matchAll(/<section ([^>]*)>[\s\S]*?<\/section>/g)) {
    if (/<section/.test(m[0].slice(1))) fail(`${where}: nested <section> - the extractor assumes there is none`);
    if (/class="[^"]*(?:prose|props|faq)/.test(m[1])) continue;
    sections.push(m[0]);
    dropped = dropped.replace(m[0], '');
  }
  if (!sections.some(s => s.startsWith('<section id="tool"'))) fail(`${where}: no <section id="tool">`);
  // Everything else in <main> is marketing and gets dropped; make sure no
  // script rides along with it.
  if (/<script/.test(dropped)) fail(`${where}: <script> in <main> outside the kept sections would be dropped`);
  const preHeader = src.slice(src.indexOf('<body>') + 6, src.indexOf('<header'));
  if (/\S/.test(preHeader)) fail(`${where}: content between <body> and <header> would be dropped`);

  // The app scripts sit between </footer> and </body> on every page.
  const footerEnd = src.indexOf('</footer>');
  if (footerEnd === -1) fail(`${where}: no </footer>`);
  const scripts = src.slice(footerEnd + '</footer>'.length, src.lastIndexOf('</body>')).trim();
  if (!scripts.includes('<script')) fail(`${where}: no app <script> after </footer>`);

  const p = lang === 'en' ? '' : '../'; // favicon path depth
  let out = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{BRAND_NAME}} ${name}</title>
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f141c" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${p}favicon.svg" type="image/svg+xml">
<link rel="icon" href="${p}favicon-48.png" type="image/png" sizes="48x48">
<link rel="apple-touch-icon" href="${p}apple-touch-icon.png">
${stripMarkers(style).replace('</style>', LOGO_CSS + '\n</style>')}
</head>
<body>

<header class="wrap">
  {{LOGO}}
  <h1>{{BRAND_NAME}} ${name}</h1>
</header>

<main class="wrap">

${sections.join('\n\n')}

</main>

<footer>
{{LANG_SWITCH}}
<div class="wrap">{{FOOTER_ATTRIBUTION}}</div>
</footer>

${stripMarkers(scripts)}
</body>
</html>
`;
  // The QR generator's default content is its own live URL; a self-hosted
  // copy should not advertise it.
  out = out.replace(/https:\/\/qrcode\.wbest\.app/g, 'https://example.com');
  return { name, html: placeholderColors(out) };
}

function buildRoot(lang, baseCss) {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{BRAND_NAME}} ${TOOLS_WORD[lang]}</title>
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f141c" media="(prefers-color-scheme: dark)">
<style>
${placeholderColors(baseCss)}
${LANDING_CSS}
${LOGO_CSS}
</style>
</head>
<body>

<header class="wrap">
  {{LOGO}}
  <h1>{{BRAND_NAME}} ${TOOLS_WORD[lang]}</h1>
</header>

<main class="wrap">
  <div class="tools">
{{TOOL_LIST}}
  </div>
</main>

<footer>
<div class="wrap">{{FOOTER_ATTRIBUTION}}</div>
</footer>

</body>
</html>
`;
}

// Every brand or SEO remnant a bare template must not contain.
const FORBIDDEN = [
  [/wbest/i, 'a WBest reference'],
  [/#(?:2563eb|e8effd|60a5fa|1c2a44)/i, 'a hard-coded accent color'],
  [/\/\* wb:|<!-- wb:/, 'a wb: marker'],
  [/i18n:/, 'an i18n: marker'],
  [/property="og:|name="twitter:/, 'an og/twitter meta'],
  [/ld\+json/, 'a JSON-LD block'],
  [/rel="canonical"|hreflang/, 'a canonical/hreflang link'],
  [/class="(?:tagline|badge|repo-link|cross-link|props|prose|faq)[" ]/, 'a marketing section'],
];

function assertBare(rel, html) {
  for (const [re, what] of FORBIDDEN) {
    const m = re.exec(html);
    if (m) fail(`${rel} still contains ${what}: ${JSON.stringify(html.slice(m.index, m.index + 60))}`);
  }
  // Every statically-referenced element the script needs must have survived
  // the stripping (guards future tools whose JS touches marketing nodes).
  // Every page aliases getElementById as $, so those references count too.
  const ids = [...html.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  if (html.includes('var $ = function (id) { return document.getElementById(id)')) {
    for (const m of html.matchAll(/[^\w$]\$\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.push(m[1]);
  }
  for (const id of ids) {
    if (!html.includes(`id="${id}"`)) fail(`${rel}: script references #${id} but no element carries id="${id}"`);
  }
}

// --- directory metadata (wbest/index.html cards) --------------------------

function parseDirectory(dirsByCanonical, deCat) {
  const wbestSrc = fs.readFileSync(path.join(ROOT, 'wbest', 'index.html'), 'utf8');
  const toolsSection = extract(wbestSrc, /<section id="tools"[\s\S]*?<\/section>/, '<section id="tools">', 'wbest/index.html')[0];
  // Catalog keys are raw page source for markup units ("Text &amp; Writing")
  // but plain text for JSON-LD values ("Base64 Encoder & Decoder"); try the
  // raw form first, then the decoded one, re-escaping the result for HTML.
  const has = s => Object.prototype.hasOwnProperty.call(deCat, s);
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const de = s => {
    if (has(s)) return deCat[s];
    const plain = s.replace(/&amp;/g, '&');
    if (has(plain)) return esc(deCat[plain]);
    fail(`wbest/i18n/de.json has no translation for ${JSON.stringify(s)} (needed by the selfhost manifest)`);
  };
  const categories = [];
  const tools = [];
  let cat = null;
  const re = /<h3 class="cat-title" id="cat-([a-z]+)">([^<]+)<\/h3>|<article class="tool card">([\s\S]*?)<\/article>/g;
  for (let m; (m = re.exec(toolsSection));) {
    if (m[1]) {
      cat = m[1];
      categories.push({ id: cat, label: { en: m[2], de: de(m[2]) } });
      continue;
    }
    const card = m[3];
    const link = extract(card, /<h3><a href="([^"]+)">([^<]+)<\/a><\/h3>/, 'card link', 'wbest/index.html card');
    const desc = extract(card, /<p class="desc">([^<]+)<\/p>/, 'card desc', `wbest card "${link[2]}"`)[1];
    const dir = dirsByCanonical.get(link[1]);
    // Cards that match no tool root (the packager's own card, say) are not
    // packageable; seo.js already fails on genuinely orphaned cards.
    if (!dir) continue;
    tools.push({ id: dir, category: cat, name: { en: link[2], de: de(link[2]) }, desc: { en: desc, de: de(desc) } });
  }
  return { categories, tools };
}

// --- main -----------------------------------------------------------------

const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'index.html')))
  .map(d => d.name)
  .filter(d => d !== 'wbest' && d !== 'selfhost')
  .sort();
if (!dirs.length) fail('No tool directories found');

// Locales must be uniform across tools: the packager offers languages
// globally, not per tool.
const langsOf = d => ['en'].concat(
  fs.existsSync(path.join(ROOT, d, 'i18n'))
    ? fs.readdirSync(path.join(ROOT, d, 'i18n')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort()
    : []);
const languages = langsOf(dirs[0]);
for (const d of dirs) {
  const l = langsOf(d);
  if (l.join() !== languages.join()) fail(`${d} has locales [${l}] but ${dirs[0]} has [${languages}] - the packager needs a uniform set`);
}
for (const l of languages) {
  if (!ATTRIBUTION[l] || !TOOLS_WORD[l] || !LANG_NAMES[l]) {
    fail(`Locale "${l}" is missing from ATTRIBUTION/TOOLS_WORD/LANG_NAMES in scripts/selfhost.js - add its strings`);
  }
}

const dirsByCanonical = new Map();
const pages = new Map(); // `${dir}.${lang}` -> source html
for (const d of dirs) {
  for (const lang of languages) {
    const rel = lang === 'en' ? path.join(d, 'index.html') : path.join(d, lang, 'index.html');
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) fail(`Missing ${rel} - run: node scripts/translate.js`);
    pages.set(`${d}.${lang}`, fs.readFileSync(file, 'utf8'));
  }
  const canonical = extract(pages.get(`${d}.en`), /<link rel="canonical" href="([^"]+)"/, 'canonical', `${d}/index.html`)[1];
  dirsByCanonical.set(canonical, d);
}

const deCat = languages.includes('de')
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'wbest', 'i18n', 'de.json'), 'utf8'))
  : {};
const { categories, tools } = parseDirectory(dirsByCanonical, deCat);
const byId = new Map(tools.map(t => [t.id, t]));
for (const d of dirs) {
  if (!byId.has(d)) fail(`${d}/ has no card in wbest/index.html - add one so the manifest knows its name/description`);
}

const files = new Map(); // rel path under selfhost/templates -> content
for (const d of dirs) {
  for (const lang of languages) {
    const { html } = buildTemplate(d, lang, pages.get(`${d}.${lang}`));
    const rel = `${d}.${lang}.html`;
    assertBare(path.join(OUT, rel), html);
    files.set(rel, html);
    byId.get(d)[`bytes_${lang}`] = Buffer.byteLength(html);
  }
}

const baseCss = stripMarkers(fs.readFileSync(path.join(ROOT, 'shared', 'base.css'), 'utf8').trim());
for (const lang of languages) {
  const rel = `root.${lang}.html`;
  const html = buildRoot(lang, baseCss);
  assertBare(path.join(OUT, rel), html);
  files.set(rel, html);
}

for (const t of tools) {
  const iconFile = path.join(ROOT, 'shared', 'icons', `${t.id}.svg`);
  if (!fs.existsSync(iconFile)) fail(`Missing shared/icons/${t.id}.svg`);
  t.icon = placeholderColors(fs.readFileSync(iconFile, 'utf8').trim());
  t.bytes = {};
  for (const lang of languages) {
    t.bytes[lang] = t[`bytes_${lang}`];
    delete t[`bytes_${lang}`];
  }
}
files.set('manifest.json', JSON.stringify({
  languages,
  langNames: Object.fromEntries(languages.map(l => [l, LANG_NAMES[l]])),
  attribution: Object.fromEntries(languages.map(l => [l, ATTRIBUTION[l]])),
  categories,
  tools,
}, null, 2) + '\n');

// --- emit -----------------------------------------------------------------

const outDir = path.join(ROOT, OUT);
let stale = [];
for (const [rel, content] of files) {
  const file = path.join(outDir, rel);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current === content) continue;
  stale.push(path.join(OUT, rel));
  if (!CHECK) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`wrote ${path.join(OUT, rel)}`);
  }
}
// Orphans: templates for tools that no longer exist.
if (fs.existsSync(outDir)) {
  for (const f of fs.readdirSync(outDir)) {
    if (files.has(f)) continue;
    stale.push(path.join(OUT, f) + ' (orphan)');
    if (!CHECK) {
      fs.unlinkSync(path.join(outDir, f));
      console.log(`removed ${path.join(OUT, f)}`);
    }
  }
}

if (CHECK) {
  if (stale.length) {
    console.error('Out of date:\n  ' + stale.join('\n  ') + '\nRun: node scripts/selfhost.js');
    process.exit(1);
  }
  console.log(`All ${files.size} selfhost templates current (${dirs.length} tools x ${languages.length} locales).`);
} else if (!stale.length) {
  console.log(`All ${files.size} selfhost templates already current.`);
}
