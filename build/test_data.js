/* Integrity check for web/data, which is built from the NBS 2022 census wards.
 *
 * The old version of this test asserted that web/data reproduced data.json
 * exactly. That is no longer the design: NBS owns the hierarchy and geometry,
 * and data.json contributes only village lists and postcodes. So the round-trip
 * assertion is replaced by a containment one -- every village we show must come
 * from data.json, but data.json is allowed to hold wards NBS has since renamed,
 * merged or split away.
 *
 * Run: node build/test_data.js */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'web', 'data');
const read = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'));

const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const index = read('index.json');

let fail = 0;
const bad = (m) => { console.log('  FAIL ' + m); fail++; };

// Mirrors norm()/ward_key()/region_key() in build/link.py.
const norm = (s) => String(s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const wardKey = (s) => norm(s).replace(/ (ward|shehia)$/, '');
const regionKey = (s) => norm(s).replace(/ region$/, '');

// data.json villages, keyed the way the builder joins them.
const source = new Map();
for (const r of rows) {
  const [reg, ward, vil] = [r.Region, r.Ward_Shehia, r.Village_Mtaa].map((v) => String(v || '').trim());
  if (!reg || !ward || !vil) continue;
  const k = `${regionKey(reg)}|${wardKey(ward)}`;
  if (!source.has(k)) source.set(k, new Set());
  source.get(k).add(vil);
}

// --- per-ward structure -----------------------------------------------------
const codes = new Map();
let total = 0, withVill = 0, withPc = 0, borrowed = 0;

for (const e of index) {
  const file = read(`wards/${e.slug}.json`);
  if (file.region !== e.region) bad(`${e.slug}: region name mismatch`);
  if (!file.wards.length) bad(`${e.slug}: no wards`);
  if (file.wards.length !== e.wards) bad(`${e.slug}: index says ${e.wards} wards, file has ${file.wards.length}`);

  const districts = [...new Set(file.wards.map((w) => w.d))];
  if (!districts.length) bad(`${e.slug}: no districts`);

  for (const d of districts) {
    const inD = file.wards.filter((w) => w.d === d);
    if (!inD.length) bad(`${e.slug}/${d}: no wards`);

    for (const w of inD) {
      total++;
      const where = `${e.slug}/${d}/${w.w}`;
      if (!w.w) bad(`${e.slug}/${d}: ward with no name`);
      if (!w.cn) bad(`${where}: no council name`);
      // Every ward comes from NBS, so every ward must have geometry and a code.
      if (!w.g) bad(`${where}: no geometry`);
      if (w.g && !['Polygon', 'MultiPolygon'].includes(w.g.type)) bad(`${where}: bad geometry type`);
      if (w.g && !w.b) bad(`${where}: geometry without bbox`);
      if (!/^\d{9}$/.test(w.code || '')) bad(`${where}: malformed ward code ${w.code}`);
      if (!codes.has(w.code)) codes.set(w.code, []);
      codes.get(w.code).push(where);
      if (!Array.isArray(w.v)) bad(`${where}: missing village array`);
      if (new Set(w.v).size !== w.v.length) bad(`${where}: duplicate villages`);
      if (w.pc !== undefined && !/^\d{5}$/.test(String(w.pc))) bad(`${where}: malformed postcode ${w.pc}`);
      if (w.c && w.c.length !== w.v.length) bad(`${where}: ${w.c.length} coords for ${w.v.length} villages`);

      if (w.v.length) {
        withVill++;
        // Containment: nothing invented. Every village must be one data.json
        // lists for this region + ward.
        const src = source.get(`${regionKey(file.region)}|${wardKey(w.w)}`);
        if (!src) {
          bad(`${where}: has villages but data.json has no such ward`);
        } else {
          const alien = w.v.filter((v) => !src.has(v));
          if (alien.length) bad(`${where}: villages not in data.json: ${alien.slice(0, 3).join(', ')}`);
        }
      }
      if (w.pc !== undefined) withPc++;
    }
  }
}

// --- ward codes -------------------------------------------------------------
// NBS reuses five codes across distinct wards. Nothing is keyed on the code, so
// these are pinned rather than fixed: the count is asserted so that a sixth
// collision, or a corrected source, fails the build instead of passing quietly.
const KNOWN_DUPE_CODES = new Set([
  '090222071',  // Mtwara/Newala: Mnekachi + Mcholi II
  '520211201',  // Kusini Unguja/Kusini: Muungoni + Tasani
  '530213233',  // Mjini Magharibi/Magharibi A: Muwembemchomeke + Masingini
  '170311031',  // Shinyanga/Shinyanga: Pandagichiza + Ilola
  '170311211',  // Shinyanga/Shinyanga: Mwenge + Masengwa
]);
const dupes = [...codes].filter(([, v]) => v.length > 1);
for (const [code, where] of dupes) {
  if (!KNOWN_DUPE_CODES.has(code)) bad(`unexpected duplicate ward code ${code}: ${where.join(' | ')}`);
}
for (const code of KNOWN_DUPE_CODES) {
  if (!codes.has(code)) bad(`known-duplicate code ${code} no longer present -- update KNOWN_DUPE_CODES`);
}
console.log(`\nward codes: ${codes.size} distinct, ${dupes.length} reused by NBS (all known)`);

// --- national totals, straight from the NBS 2022 census ---------------------
const councils = new Set();
for (const e of index) for (const w of read(`wards/${e.slug}.json`).wards) councils.add(`${e.region}|${w.cn}`);
const expect = (label, got, want) => {
  if (got !== want) bad(`${label}: ${got}, expected ${want}`);
  else console.log(`  ok   ${label}: ${got}`);
};
console.log('NBS 2022 census totals');
expect('regions', index.length, 31);
expect('councils', councils.size, 195);
expect('wards', total, 4344);

// --- councils created after data.json was compiled --------------------------
// This is the bug that prompted the rebuild: Ubungo (split from Kinondoni,
// 2016) and Kigamboni (from Temeke, 2015) exist in neither data.json nor the
// 2015/2018 boundary sets, so a Kimara resident was told "Kinondoni".
console.log('\npost-2015 council splits');
const dar = read('wards/dar-es-salaam.json').wards;
for (const [ward, want] of [['Kimara', 'Ubungo'], ['Saranga', 'Ubungo'],
                            ['Msigani', 'Ubungo'], ['Kigamboni', 'Kigamboni']]) {
  const w = dar.find((x) => x.w === ward);
  if (!w) bad(`Dar es Salaam: ward ${ward} missing`);
  else if (w.d !== want) bad(`${ward}: district is ${w.d}, expected ${want}`);
  else console.log(`  ok   ${ward} -> ${w.d} (${w.cn})`);
}

// --- coverage ---------------------------------------------------------------
const nVill = index.reduce((n, e) => n + e.villages, 0);
const located = index.reduce((n, e) => n + e.located, 0);
console.log(`\nvillages: ${withVill}/${total} wards carry a list from data.json ` +
            `(${(100 * withVill / total).toFixed(1)}%)`);
console.log(`          ${nVill} villages, ${located} with coordinates (${(100 * located / nVill).toFixed(1)}%)`);
console.log(`postcode: ${withPc}/${total} wards (${(100 * withPc / total).toFixed(1)}%)`);

const sizes = index.map((e) => e.kb).sort((a, b) => b - a);
const kb = (p) => Math.round(fs.statSync(path.join(DATA, p)).size / 1024);
console.log(`payload : index ${kb('index.json')} KB + regions ${kb('regions.json')} KB + one region file ` +
            `(median ${sizes[Math.floor(sizes.length / 2)]} KB, max ${sizes[0]} KB)`);

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
process.exit(fail ? 1 : 0);
