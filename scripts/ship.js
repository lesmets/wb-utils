#!/usr/bin/env node
// Ship gate: every mechanical check a page must pass before it deploys.
//
// The suite has three generators, each with a --check mode that fails on drift:
//   sync.js       shared partials stamped into every page's wb: markers
//   translate.js  locale pages generated from each root's i18n/<locale>.json
//   seo.js        robots.txt, sitemap.xml, llms.txt projected from each page
//
// They exist as separate scripts because they own separate things, but they are
// not independent: each reads what the previous one writes, so the order is
// fixed at sync.js -> translate.js -> seo.js and a failure early on can cascade
// into noisy failures later. This runs all three anyway rather than stopping at
// the first, so one pass shows the whole picture; fix them in order and re-run.
//
// This script exists because the checks are individually easy to run and
// individually easy to forget, and the one you forget is the one that matters.
// Copy edits are the sharp case: a catalog is keyed by the English string, so
// rewording an English sentence silently orphans its translation and ships a
// half-English locale page. Only translate.js --check says so, and nothing
// about the English page looks wrong.
//
// Usage:
//   node scripts/ship.js         run every check, exit 1 if any fails
//   node scripts/ship.js --fix   run every generator in order, then re-check

'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const FIX = process.argv.includes('--fix');
const STEPS = ['sync', 'translate', 'seo'];

function run(name, args) {
  const res = spawnSync(process.execPath, [path.join(__dirname, `${name}.js`), ...args], { encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.status === 0, out };
}

function indent(text) {
  return text.split('\n').map(l => `    ${l}`).join('\n');
}

if (FIX) {
  console.log('Regenerating (sync -> translate -> seo)\n');
  for (const name of STEPS) {
    const { ok, out } = run(name, []);
    if (out) console.log(indent(out));
    if (!ok) {
      console.error(`\n${name}.js failed. Nothing further was run.`);
      process.exit(1);
    }
  }
  console.log('');
}

const failed = [];
for (const name of STEPS) {
  const { ok, out } = run(name, ['--check']);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} --check`);
  if (!ok) {
    failed.push(name);
    if (out) console.log(indent(out));
  }
}

if (failed.length) {
  console.error(
    `\n${failed.length} of ${STEPS.length} checks failed: ${failed.join(', ')}.` +
    '\nFix in order (sync -> translate -> seo); an earlier failure can cause a later one.' +
    '\nTo regenerate everything: node scripts/ship.js --fix'
  );
  process.exit(1);
}

console.log(`\nAll ${STEPS.length} checks passed. Safe to deploy.`);
