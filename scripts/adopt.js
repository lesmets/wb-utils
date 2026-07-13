#!/usr/bin/env node
// Adopt a page into the shared-CSS system: replaces its inline copy of the
// canonical base styles with the /* wb:base */ marker pair, relocates any
// per-tool :root variables and .wrap width override to after the markers,
// and removes rules now owned by shared/base.css. Run sync.js afterwards.
//
// Usage: node scripts/adopt.js <page.html> [more.html ...]
'use strict';
const fs = require('fs');
const path = require('path');

const CANON = new Set(['--bg','--card','--text','--muted','--accent','--accent-soft','--border','--over','--shadow']);

for (const arg of process.argv.slice(2)) {
  const file = path.resolve(arg);
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('wb:base:start')) { console.log(`${arg}: already has markers, skipping`); continue; }

  const styleStart = src.indexOf('<style>');
  const styleEnd = src.indexOf('</style>');
  if (styleStart === -1) { console.error(`${arg}: no <style> block`); process.exitCode = 1; continue; }
  const css = src.slice(styleStart + 7, styleEnd);

  const parseVars = b => Object.fromEntries([...b.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  const lightM = css.match(/:root\{([\s\S]*?)\}/);
  const darkM = css.match(/@media \(prefers-color-scheme: dark\)\{\s*:root\{([\s\S]*?)\}\s*\}/);
  if (!lightM || !darkM) { console.error(`${arg}: missing :root blocks`); process.exitCode = 1; continue; }

  const pick = vars => Object.entries(vars).filter(([k]) => !CANON.has(k));
  const extraLight = pick(parseVars(lightM[1]));
  const extraDark = pick(parseVars(darkM[1]));

  const headEndMark = 'p{margin:0 0 12px}';
  const headEnd = css.indexOf(headEndMark);
  if (headEnd === -1) { console.error(`${arg}: canonical head not found`); process.exitCode = 1; continue; }

  const wrapM = css.match(/\.wrap\{max-width:(\d+)px;margin:0 auto;padding:0 16px\}/);
  const wrapOverride = wrapM && wrapM[1] !== '1080' ? wrapM[0] : null;

  let tail = css.slice(headEnd + headEndMark.length);
  const removals = [
    /\n\.card\{background:var\(--card\);border:1px solid var\(--border\);border-radius:12px;box-shadow:var\(--shadow\)\}/,
    /\n\.muted\{color:var\(--muted\)\}/,
    /\n[a-z:,-]*focus-visible[^\n]*outline-offset:2px\}/,
    /\nfooter\{border-top:1px solid var\(--border\);padding:22px 0 34px;text-align:center;font-size:\.85rem;color:var\(--muted\)\}/,
    /\n\.sr-only\{position:absolute[^\n]*border:0\}/,
  ];
  for (const re of removals) tail = tail.replace(re, '');

  let extras = '';
  const fmt = pairs => pairs.map(([k, v]) => `  ${k}:${v};`).join('\n');
  if (extraLight.length) extras += `:root{\n${fmt(extraLight)}\n}\n`;
  if (extraDark.length) extras += `@media (prefers-color-scheme: dark){\n  :root{\n  ${fmt(extraDark).replace(/\n/g, '\n  ')}\n  }\n}\n`;
  if (wrapOverride) extras += wrapOverride + '\n';

  const out = src.slice(0, styleStart + 7) +
    `\n/* wb:base:start */\n/* wb:base:end */\n${extras}${tail.replace(/^\n+/, '')}` +
    src.slice(styleEnd);
  fs.writeFileSync(file, out);
  console.log(`adopted ${arg}${extras ? ' (moved per-tool vars/overrides)' : ''} - now run: node scripts/sync.js`);
}
