#!/usr/bin/env node
// Generate locale pages from each root's English index.html + string catalogs.
//
// The English page is the single source of truth for structure, style, and
// logic; a catalog (i18n/<locale>.json) is a flat gettext-style map keyed by
// the English string itself: { "English text": "Übersetzter Text" }. This
// script extracts every translatable unit from the English page mechanically -
// <title>, whitelisted meta content, JSON-LD string values, leaf-element
// innerHTML, translatable attributes, and the string values of the page's
// `I18N` object between /* i18n:js:start/end */ markers - looks each up in the
// catalog, and writes <root>/<locale>/index.html. Keys are raw page source, so
// catalog values use the same escaping as the spot they land in (&amp; in HTML
// contexts, plain text in JSON-LD).
//
// Because keys are the English text, drift is mechanical: change English copy
// and the old catalog entry turns up as stale while the new text turns up as
// missing - generation refuses to ship a half-translated page. Change style,
// layout, or JS without touching copy and locale pages regenerate with zero
// catalog edits.
//
// The script also owns two marker blocks, stamped into every variant
// (including the English page, so the cluster is always self-consistent):
//   <!-- i18n:hreflang:start/end -->   the full rel=alternate cluster in <head>
//   <!-- i18n:lang:start/end -->       the language dropdown in the header
// Markers deliberately use the i18n: prefix - sync.js owns wb: markers and
// hard-fails on any wb: marker without a shared/ partial.
//
// A root opts in by having an i18n/ directory; roots without one are skipped.
// Run order: sync.js -> translate.js -> seo.js.
//
// Usage:
//   node scripts/translate.js          rewrite locale pages + stamped blocks
//   node scripts/translate.js --check  exit 1 on drift, missing or stale keys
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECK = process.argv.includes('--check');

// Endonyms for the dropdown; extend as the roadmap's language rollout grows.
const LANG_NAMES = {
  en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español',
  'pt-br': 'Português (Brasil)', it: 'Italiano', nl: 'Nederlands',
  pl: 'Polski', tr: 'Türkçe', id: 'Bahasa Indonesia',
};

// Elements whose innerHTML is one translation unit when it contains only
// inline markup - keeps "<strong>125–150 words</strong> per minute" together.
const UNIT = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th',
  'caption', 'figcaption', 'button', 'label', 'summary', 'legend', 'option',
  'dt', 'dd', 'a', 'span', 'strong', 'em', 'title']);
const INLINE = new Set(['a', 'abbr', 'b', 'br', 'code', 'em', 'i', 'kbd', 'small', 'strong', 'sub', 'sup', 'wbr']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea']);
const ATTRS = /\b(placeholder|title|aria-label|alt)="([^"]*)"/g;
const METAS = /(<meta\s+(?:name|property)="(?:description|og:title|og:description|og:site_name|twitter:title|twitter:description)"\s+content=")([^"]*)(")/g;
// JSON-LD keys whose string values are identifiers, not copy.
const LD_SKIP = new Set(['@context', '@type', '@id', 'url', 'price', 'priceCurrency', 'applicationCategory', 'operatingSystem']);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// A string is worth translating only if it contains a letter.
const translatable = s => /\p{L}/u.test(s);

// tx wraps a catalog: it records every key it is asked for (so stale entries
// can be detected) and every key the catalog lacks (so generation can refuse).
function makeTx(catalog, used, missing) {
  return s => {
    used.add(s);
    if (Object.prototype.hasOwnProperty.call(catalog, s)) return catalog[s];
    missing.add(s);
    return s;
  };
}

function txAttrs(tag, tx) {
  return tag.replace(ATTRS, (m, name, val) => translatable(val) ? `${name}="${tx(val)}"` : m);
}

function txText(s, tx) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  return m[2] && translatable(m[2]) ? m[1] + tx(m[2]) + m[3] : s;
}

function isUnit(inner) {
  if (inner.includes('<!--')) return false;
  for (const m of inner.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    if (!INLINE.has(m[1].toLowerCase())) return false;
  }
  return true;
}

function findClose(html, from, name) {
  const re = new RegExp(`<(/?)${name}\\b`, 'gi');
  re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (!depth) return { start: m.index, end: html.indexOf('>', m.index) + 1 };
  }
  fail(`Unclosed <${name}> while translating`);
}

// Recursive descent over the markup: leaf elements become whole translation
// units, containers recurse, bare text nodes translate individually, and
// script/style bodies pass through untouched (they are handled separately).
function walkMarkup(html, tx) {
  let out = '', i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return out + txText(html.slice(i), tx);
    out += txText(html.slice(i, lt), tx);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt) + 3;
      out += html.slice(lt, end);
      i = end;
      continue;
    }
    if (html[lt + 1] === '!') { // doctype
      const end = html.indexOf('>', lt) + 1;
      out += html.slice(lt, end);
      i = end;
      continue;
    }
    const m = /^<\/?[a-zA-Z][a-zA-Z0-9-]*((?:"[^"]*"|'[^']*'|[^"'>])*)>/.exec(html.slice(lt));
    if (!m) fail(`Unparsable tag at: ${html.slice(lt, lt + 60)}`);
    const tag = m[0];
    const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)[1].toLowerCase();
    const openEnd = lt + tag.length;
    if (tag[1] === '/' || VOID.has(name) || /\/>$/.test(tag)) {
      out += txAttrs(tag, tx);
      i = openEnd;
      continue;
    }
    const close = findClose(html, openEnd, name);
    const inner = html.slice(openEnd, close.start);
    out += txAttrs(tag, tx);
    if (RAW.has(name)) out += inner;
    else if (UNIT.has(name) && isUnit(inner)) out += txText(inner, tx);
    else out += walkMarkup(inner, tx);
    out += html.slice(close.start, close.end);
    i = close.end;
  }
  return out;
}

// Translate every string value in parsed JSON (JSON-LD or the I18N object),
// leaving identifiers, URLs, and numbers alone; the page's canonical URL is
// rewritten to the locale's.
function txJson(node, tx, baseUrl, localeUrl, key) {
  if (typeof node === 'string') {
    if (baseUrl && node === baseUrl) return localeUrl;
    if (LD_SKIP.has(key) || /^https?:/.test(node) || !translatable(node)) return node;
    return tx(node);
  }
  if (Array.isArray(node)) return node.map(v => txJson(v, tx, baseUrl, localeUrl, key));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, txJson(v, tx, baseUrl, localeUrl, k)]));
  }
  return node;
}

// Reset both stamped blocks to empty so generation never re-extracts its own
// output (the dropdown's language names would otherwise become keys).
function blankStamps(html) {
  return html
    .replace(/(<!-- i18n:hreflang:start -->)[\s\S]*?(<!-- i18n:hreflang:end -->)/, '$1$2')
    .replace(/(<!-- i18n:lang:start -->)[\s\S]*?(<!-- i18n:lang:end -->)/, '$1$2');
}

function stamp(html, name, body) {
  const re = new RegExp(`(<!-- i18n:${name}:start -->)([\\s\\S]*?)(<!-- i18n:${name}:end -->)`);
  if (!re.test(html)) fail(`Missing <!-- i18n:${name}:start/end --> markers`);
  return html.replace(re, `$1\n${body}\n$3`);
}

const hreflangCode = l => l.replace(/-(\w+)$/, (m, r) => '-' + r.toUpperCase());
const localeUrlOf = (baseUrl, l) => l === 'en' ? baseUrl : `${baseUrl}${l}/`;

function hreflangBlock(baseUrl, variants) {
  const lines = variants.map(l =>
    `<link rel="alternate" hreflang="${hreflangCode(l)}" href="${localeUrlOf(baseUrl, l)}">`);
  lines.push(`<link rel="alternate" hreflang="x-default" href="${baseUrl}">`);
  return lines.join('\n');
}

function langBlock(baseUrl, variants, current) {
  const items = variants.map(l => {
    const name = LANG_NAMES[l] || fail(`No display name for locale "${l}" - add it to LANG_NAMES in scripts/translate.js`);
    return l === current
      ? `      <li aria-current="page">${name}</li>`
      : `      <li><a href="${localeUrlOf(baseUrl, l)}" lang="${l}" hreflang="${hreflangCode(l)}">${name}</a></li>`;
  });
  return [
    '  <details class="lang">',
    `    <summary>🌐 ${current.toUpperCase()}</summary>`,
    '    <ul>',
    ...items,
    '    </ul>',
    '  </details>',
  ].join('\n');
}

function stampVariant(html, baseUrl, variants, current) {
  html = stamp(html, 'hreflang', hreflangBlock(baseUrl, variants));
  return stamp(html, 'lang', langBlock(baseUrl, variants, current));
}

// Shift JSON.stringify output to sit at the I18N object's indent depth.
function indentJson(obj, pad) {
  return JSON.stringify(obj, null, 2).split('\n').map((l, i) => i ? pad + l : l).join('\n');
}

function generate(src, locale, catalog, baseUrl, variants, used, missing) {
  const tx = makeTx(catalog, used, missing);
  const localeUrl = localeUrlOf(baseUrl, locale);
  let out = blankStamps(src)
    .replace(/(<html\s+lang=")[^"]*(")/, `$1${locale}$2`)
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1${localeUrl}$2`)
    .replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/, `$1${localeUrl}$2`)
    .replace(METAS, (m, pre, val, post) => pre + tx(val) + post);
  out = out.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (m, pre, body, post) => {
    let obj;
    try { obj = JSON.parse(body); } catch (e) { fail(`Invalid JSON-LD: ${e.message}`); }
    return `${pre}\n${JSON.stringify(txJson(obj, tx, baseUrl, localeUrl, null), null, 2)}\n${post}`;
  });
  out = out.replace(/(\/\* i18n:js:start \*\/[\s\S]*?var I18N = )([\s\S]*?)(;[\s\S]*?\/\* i18n:js:end \*\/)/, (m, pre, body, post) => {
    let obj;
    try { obj = JSON.parse(body); } catch (e) { fail(`I18N object between i18n:js markers is not strict JSON: ${e.message}`); }
    return pre + indentJson(txJson(obj, tx, null, null, null), '  ') + post;
  });
  out = walkMarkup(out, tx);
  return stampVariant(out, baseUrl, variants, locale);
}

// --- main ---------------------------------------------------------------

const dirs = ['.'].concat(
  fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'index.html')))
    .map(d => d.name)
    .sort()
);
const roots = dirs.filter(d => fs.existsSync(path.join(ROOT, d, 'i18n')));

let stale = [], problems = [];

function emit(rel, content) {
  const file = path.join(ROOT, rel);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current === content) return;
  stale.push(rel);
  if (!CHECK) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`wrote ${rel}`);
  }
}

for (const dir of roots) {
  const srcPath = path.join(dir === '.' ? '' : dir, 'index.html');
  const src = fs.readFileSync(path.join(ROOT, srcPath), 'utf8');
  const baseMatch = src.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
  if (!baseMatch) fail(`No canonical URL in ${srcPath}`);
  const baseUrl = baseMatch[1].replace(/\/?$/, '/');
  const locales = fs.readdirSync(path.join(ROOT, dir, 'i18n'))
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .sort();
  if (!locales.length) continue;
  const variants = ['en'].concat(locales);

  for (const locale of locales) {
    const catPath = path.join(dir === '.' ? '' : dir, 'i18n', `${locale}.json`);
    const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, catPath), 'utf8'));
    const used = new Set(), missing = new Set();
    const page = generate(src, locale, catalog, baseUrl, variants, used, missing);
    const orphans = Object.keys(catalog).filter(k => !used.has(k));
    if (missing.size) {
      problems.push(`${catPath} is missing ${missing.size} translation(s):\n` +
        [...missing].map(k => `  ${JSON.stringify(k)}`).join('\n'));
    }
    if (orphans.length) {
      const note = `${catPath} has ${orphans.length} stale entr${orphans.length === 1 ? 'y' : 'ies'} (English text no longer on the page):\n` +
        orphans.map(k => `  ${JSON.stringify(k)}`).join('\n');
      if (CHECK || missing.size) problems.push(note);
      else console.warn(note);
    }
    if (missing.size) continue; // never ship a half-translated page
    emit(path.join(dir === '.' ? '' : dir, locale, 'index.html'), page);
  }

  // The English page carries the same hreflang cluster and dropdown.
  emit(srcPath, stampVariant(blankStamps(src), baseUrl, variants, 'en'));
}

if (problems.length) {
  fail(problems.join('\n') + '\nTranslate the missing keys (and delete stale ones), then rerun: node scripts/translate.js');
}
if (CHECK) {
  if (stale.length) {
    console.error('Out of date:\n  ' + stale.join('\n  ') + '\nRun: node scripts/translate.js');
    process.exit(1);
  }
  console.log(`All locale pages for ${roots.length} root(s) are current.`);
} else if (!stale.length) {
  console.log(`All locale pages for ${roots.length} root(s) already current.`);
}
