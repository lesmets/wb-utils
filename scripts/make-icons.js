#!/usr/bin/env node
// Distribute the unified icon set to every deploy root.
//
// Sources: shared/icons/<name>.svg (name = deploy-root directory).
// Each deploy root gets: favicon.svg (copy of the source), favicon-48.png,
// apple-touch-icon.png (180x180).
//
// PNGs come from a JSON file of base64 data ({ name: { png48, png180 } })
// rasterized in a browser, since Node alone can't render SVG. To regenerate
// after changing a glyph, serve the repo and run this in the browser console
// on any page, then save the JSON and pass its path to this script:
//
//   const names = [...]; const out = {};
//   for (const n of names) {
//     const svg = await (await fetch('/shared/icons/'+n+'.svg')).text();
//     const img = new Image();
//     const url = URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
//     await new Promise(r => { img.onload = r; img.src = url; });
//     const render = s => { const c = document.createElement('canvas');
//       c.width = c.height = s; c.getContext('2d').drawImage(img,0,0,s,s);
//       return c.toDataURL('image/png').split(',')[1]; };
//     out[n] = { png48: render(48), png180: render(180) };
//   }
//   copy(JSON.stringify(out));   // then paste into icons.json
//
// Usage: node scripts/make-icons.js <icons.json>

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'shared', 'icons');
const jsonPath = process.argv[2];
if (!jsonPath) { console.error('Usage: node scripts/make-icons.js <icons.json>'); process.exit(1); }
const pngs = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

for (const file of fs.readdirSync(ICONS)) {
  if (!file.endsWith('.svg')) continue;
  const name = file.replace(/\.svg$/, '');
  const dest = path.join(ROOT, name);
  if (!fs.existsSync(path.join(dest, 'index.html'))) {
    console.error(`skip ${name}: no ${name}/index.html`);
    continue;
  }
  if (!pngs[name]) { console.error(`skip ${name}: not in ${jsonPath}`); continue; }
  fs.copyFileSync(path.join(ICONS, file), path.join(dest, 'favicon.svg'));
  fs.writeFileSync(path.join(dest, 'favicon-48.png'), Buffer.from(pngs[name].png48, 'base64'));
  fs.writeFileSync(path.join(dest, 'apple-touch-icon.png'), Buffer.from(pngs[name].png180, 'base64'));
  console.log(`icons -> ${name}/`);
}
