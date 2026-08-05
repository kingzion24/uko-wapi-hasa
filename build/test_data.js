/* Integrity check: the per-region web files must reproduce data.json exactly,
 * and the manual picker's cascade must yield a non-empty list at every level.
 * Run: node build/test_data.js */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'web', 'data');
const read = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'));

const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const index = read('index.json');

// Rows with a blank level are dropped at build time (see web_data.py).
const levels = (r) => [r.Region, r.District, r.Ward_Shehia, r.Village_Mtaa];
const complete = rows.filter((r) => levels(r).every((v) => String(v || '').trim()));
const want = new Set(complete.map((r) => levels(r).join('|')));
console.log(`source rows: ${rows.length}, dropped for blank level: ${rows.length - complete.length}`);
const got = new Set();
let fail = 0;
const bad = (m) => { console.log('  FAIL ' + m); fail++; };

// --- cascade + round-trip ---------------------------------------------------
for (const e of index) {
  const file = read(`wards/${e.slug}.json`);
  if (file.region !== e.region) bad(`${e.slug}: region name mismatch`);
  if (!file.wards.length) bad(`${e.slug}: no wards`);

  const districts = [...new Set(file.wards.map((w) => w.d))];
  if (!districts.length) bad(`${e.slug}: no districts`);

  for (const d of districts) {
    const inD = file.wards.filter((w) => w.d === d);
    if (!inD.length) bad(`${e.slug}/${d}: no wards`);
    for (const w of inD) {
      if (!w.w) bad(`${e.slug}/${d}: ward with no name`);
      if (!w.v || !w.v.length) bad(`${e.slug}/${d}/${w.w}: no villages`);
      if (new Set(w.v).size !== w.v.length) bad(`${e.slug}/${d}/${w.w}: duplicate villages`);
      for (const v of w.v) got.add([file.region, w.d, w.w, v].join('|'));
      if (w.g && !w.b) bad(`${e.slug}/${d}/${w.w}: geometry without bbox`);
      if (w.g && !['Polygon', 'MultiPolygon'].includes(w.g.type)) bad(`${w.w}: bad geometry type`);
    }
  }
}

const missing = [...want].filter((k) => !got.has(k));
const extra = [...got].filter((k) => !want.has(k));
console.log('round-trip data.json -> web/data');
console.log(`  unique rows in data.json : ${want.size}`);
console.log(`  reproduced from web/data : ${got.size}`);
if (missing.length) { bad(`${missing.length} rows lost, e.g. ${missing.slice(0, 3).join(' ; ')}`); }
if (extra.length) { bad(`${extra.length} invented rows, e.g. ${extra.slice(0, 3).join(' ; ')}`); }
if (!missing.length && !extra.length) console.log('  ok — exact match, nothing lost or invented');

// --- coverage ---------------------------------------------------------------
const mapped = index.reduce((n, e) => n + e.mapped, 0);
const total = index.reduce((n, e) => n + e.wards, 0);
console.log(`\ncoverage: ${mapped}/${total} wards have a polygon (${(100 * mapped / total).toFixed(1)}%)`);

const sizes = index.map((e) => e.kb).sort((a, b) => b - a);
console.log(`payload : index 3 KB + regions 93 KB + one region file ` +
            `(median ${sizes[Math.floor(sizes.length / 2)]} KB, max ${sizes[0]} KB)`);

const noGeom = [];
for (const e of index) {
  const n = read(`wards/${e.slug}.json`).wards.filter((w) => !w.g).length;
  if (n) noGeom.push(`${e.region} ${n}`);
}
console.log(`wards without polygon by region: ${noGeom.join(', ')}`);

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
process.exit(fail ? 1 : 0);
