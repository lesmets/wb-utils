#!/usr/bin/env node
// Sync shared partials into every tool page.
//
// Each index.html contains marker pairs inside <style> (or anywhere):
//   /* wb:base:start */ ... /* wb:base:end */
//   <!-- wb:base:start --> ... <!-- wb:base:end -->
// The content between a pair is replaced with the contents of shared/<name>.css
// (or shared/<name>.html for HTML-comment markers).
//
// Usage:
//   node scripts/sync.js          rewrite pages from shared/ partials
//   node scripts/sync.js --check  exit 1 if any page is out of sync (no writes)

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHARED = path.join(ROOT, 'shared');
const CHECK = process.argv.includes('--check');

const pages = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'index.html')))
  .map(d => path.join(d.name, 'index.html'));

const MARKER = /(\/\* wb:([a-z0-9-]+):start \*\/|<!-- wb:([a-z0-9-]+):start -->)([\s\S]*?)(\/\* wb:\2\3:end \*\/|<!-- wb:\2\3:end -->)/g;

const partials = new Map();
function partial(name, isCss) {
  const key = name + (isCss ? '.css' : '.html');
  if (!partials.has(key)) {
    const file = path.join(SHARED, key);
    if (!fs.existsSync(file)) {
      console.error(`Missing partial: shared/${key}`);
      process.exit(1);
    }
    partials.set(key, fs.readFileSync(file, 'utf8').trim());
  }
  return partials.get(key);
}

let stale = [];
for (const page of pages) {
  const file = path.join(ROOT, page);
  const src = fs.readFileSync(file, 'utf8');
  let found = 0;
  const out = src.replace(MARKER, (m, open, cssName, htmlName, _body, close) => {
    found++;
    const isCss = Boolean(cssName);
    return `${open}\n${partial(cssName || htmlName, isCss)}\n${close}`;
  });
  if (found === 0) {
    console.error(`No wb: markers found in ${page}`);
    process.exit(1);
  }
  if (out !== src) {
    stale.push(page);
    if (!CHECK) {
      fs.writeFileSync(file, out);
      console.log(`synced ${page}`);
    }
  }
}

if (CHECK) {
  if (stale.length) {
    console.error('Out of sync:\n  ' + stale.join('\n  ') + '\nRun: node scripts/sync.js');
    process.exit(1);
  }
  console.log(`All ${pages.length} pages in sync.`);
} else if (!stale.length) {
  console.log(`All ${pages.length} pages already in sync.`);
}
