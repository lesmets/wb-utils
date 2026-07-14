#!/usr/bin/env node
// Generate robots.txt + sitemap.xml for every root (each tool + the directory).
//
// Each subdomain/domain is its own site to search engines, so every root gets
// its own robots.txt and sitemap.xml keyed to that host's canonical URL (read
// from the <link rel="canonical"> in its index.html — the single source of
// truth). Tool sitemaps list just their one URL today; the directory sitemap
// lists every tool URL, making it the suite's crawl hub. Guide/locale URLs get
// added here as they appear.
//
// Usage:
//   node scripts/seo.js          write robots.txt + sitemap.xml to every root
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

function canonical(dir) {
  const html = fs.readFileSync(path.join(ROOT, dir, 'index.html'), 'utf8');
  const m = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
  if (!m) {
    console.error(`No canonical URL in ${path.join(dir, 'index.html')}`);
    process.exit(1);
  }
  // Normalize to a trailing slash so URLs match the served path exactly.
  return m[1].replace(/\/?$/, '/');
}

// Map every root to its canonical base URL up front so the directory sitemap
// can list all tool URLs.
const base = new Map(roots.map(dir => [dir, canonical(dir)]));

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

function sitemap(dir) {
  // Directory root lists itself + every tool; a tool lists only itself.
  const urls = dir === '.'
    ? roots.map(d => base.get(d))
    : [base.get(dir)];
  const entries = urls.map(u => `  <url>\n    <loc>${u}</loc>\n  </url>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries,
    '</urlset>',
    '',
  ].join('\n');
}

let stale = [];
for (const dir of roots) {
  for (const [name, content] of [['robots.txt', robots(dir)], ['sitemap.xml', sitemap(dir)]]) {
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

if (CHECK) {
  if (stale.length) {
    console.error('Out of date:\n  ' + stale.join('\n  ') + '\nRun: node scripts/seo.js');
    process.exit(1);
  }
  console.log(`All ${roots.length} roots have current robots.txt + sitemap.xml.`);
} else if (!stale.length) {
  console.log(`All ${roots.length} roots already current.`);
}
