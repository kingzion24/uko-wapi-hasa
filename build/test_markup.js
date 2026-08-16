/* Cheap structural checks on the page: every id app.js reaches for exists,
 * block tags balance, and no third-party asset requests have crept back in.
 * Run: node build/test_markup.js */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');

let fail = 0;
const bad = (m) => { console.log('  FAIL ' + m); fail++; };

// --- ids ---------------------------------------------------------------
const used = new Set([...app.matchAll(/\$\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));
for (const arr of [...app.matchAll(/\[([^\]]*?)\]\.map\(\$\)/g)].map((m) => m[1])) {
  for (const m of arr.matchAll(/'([^']+)'/g)) used.add(m[1]);
}
const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const missing = [...used].filter((u) => !defined.has(u));
console.log(`ids referenced by app.js: ${used.size}`);
if (missing.length) bad(`ids missing from index.html: ${missing.join(', ')}`);

// --- tag balance -------------------------------------------------------
for (const t of ['html', 'head', 'body', 'main', 'footer', 'section', 'div',
                 'details', 'summary', 'dl', 'dd', 'ul', 'li', 'select', 'label']) {
  const open = [...html.matchAll(new RegExp(`<${t}(\\s|>)`, 'g'))].length;
  const close = [...html.matchAll(new RegExp(`</${t}>`, 'g'))].length;
  if (open !== close) bad(`<${t}> unbalanced: ${open} open, ${close} close`);
}

// --- local assets only -------------------------------------------------
const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !/^https:\/\/(www\.geoboundaries|data\.humdata|www\.openstreetmap|www\.linkedin|www\.tanzaniapostcode|www\.posta|napa\.mawasiliano)/.test(u))
  .filter((u) => !u.startsWith('https://ukowapi.site/'));   // canonical, not a request
if (remote.length) bad(`third-party asset requests: ${remote.join(', ')}`);

// --- local files referenced actually exist -----------------------------
for (const rel of [...html.matchAll(/(?:src|href)="(?!https?:|mailto:|#)([^"]+)"/g)].map((m) => m[1])) {
  if (!fs.existsSync(path.join(ROOT, 'web', rel))) bad(`missing file: ${rel}`);
}

console.log(fail ? `\n${fail} FAILURES` : 'markup ok');
process.exit(fail ? 1 : 0);
