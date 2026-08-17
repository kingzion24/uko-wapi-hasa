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
// Only flag markup that makes the browser fetch something. An <a href> to
// another site is a link the reader may click, not a request the page issues,
// so listing every cited source in an allowlist was the wrong check -- it made
// adding a citation fail the build.
const fetched = [
  ...[...html.matchAll(/<(?:img|script|iframe|source|embed|video|audio)\b[^>]*?\bsrc="([^"]+)"/gi)],
  ...[...html.matchAll(/<link\b[^>]*?\bhref="([^"]+)"/gi)],
].map((m) => m[1]);
const remote = fetched.filter((u) => /^https?:\/\//.test(u) && !u.startsWith('https://ukowapi.site/'));
if (remote.length) bad(`third-party asset requests: ${remote.join(', ')}`);
console.log(`assets fetched by the page: ${fetched.length}, all local`);

// --- local files referenced actually exist -----------------------------
for (const rel of [...html.matchAll(/(?:src|href)="(?!https?:|mailto:|#|data:)([^"]+)"/g)].map((m) => m[1])) {
  if (!fs.existsSync(path.join(ROOT, 'web', rel))) bad(`missing file: ${rel}`);
}

console.log(fail ? `\n${fail} FAILURES` : 'markup ok');
process.exit(fail ? 1 : 0);
