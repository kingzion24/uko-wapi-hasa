/* Resolve known Tanzanian coordinates through the same geometry code the
 * browser runs. Run: node build/test_geo.js */
const fs = require('fs');
const path = require('path');
const { inBbox, pointInGeom, distToBoundary, distMeters, fmtDist } = require('../web/geo.js');

// Mirrors fillVillages() in app.js: nearest located village in the ward.
function guessVillage(ward, lng, lat) {
  const coords = ward.c || [];
  const known = ward.v
    .map((name, i) => ({ name, c: coords[i] || null }))
    .filter((x) => x.c)
    .map((x) => ({ ...x, d: distMeters(lng, lat, x.c[0], x.c[1]) }))
    .sort((a, b) => a.d - b.d);
  return known[0] || null;
}

const DATA = path.join(__dirname, '..', 'web', 'data');
const read = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'));

const index = read('index.json');
const regions = read('regions.json');
const wardCache = new Map();
const wards = (slug) => {
  if (!wardCache.has(slug)) wardCache.set(slug, read(`wards/${slug}.json`));
  return wardCache.get(slug);
};

function candidates(lng, lat) {
  const out = [];
  for (const f of regions.features) if (pointInGeom(lng, lat, f.geometry)) out.push(f.properties.slug);
  for (const e of index) if (!out.includes(e.slug) && inBbox(lng, lat, e.bbox)) out.push(e.slug);
  return out;
}

function resolve(lng, lat) {
  for (const slug of candidates(lng, lat)) {
    const file = wards(slug);
    const hit = file.wards.find((w) => w.g && inBbox(lng, lat, w.b) && pointInGeom(lng, lat, w.g));
    if (hit) return { region: file.region, ward: hit, exact: true };
  }
  let best = null;
  for (const slug of candidates(lng, lat)) {
    for (const w of wards(slug).wards) {
      if (!w.g) continue;
      const d = distToBoundary(lng, lat, w.g);
      if (!best || d < best.dist) best = { region: wards(slug).region, ward: w, dist: d, exact: false };
    }
  }
  return best;
}

// [name, lat, lng, expected region]
const CASES = [
  ['Dodoma city centre',        -6.1722, 35.7395, 'Dodoma'],
  ['Kariakoo, Dar es Salaam',   -6.8161, 39.2803, 'Dar es Salaam Region'],
  ['Arusha clock tower',        -3.3689, 36.6829, 'Arusha'],
  ['Mwanza city',               -2.5164, 32.9175, 'Mwanza'],
  ['Stone Town, Zanzibar',      -6.1659, 39.1917, 'Mjini Magharibi'],
  ['Mbeya town',                -8.9094, 33.4608, 'Mbeya'],
  ['Moshi',                     -3.3349, 37.3408, 'Kilimanjaro'],
  ['Morogoro town',             -6.8221, 37.6612, 'Morogoro'],
  ['Tanga city',                -5.0689, 39.0988, 'Tanga'],
  ['Mtwara town',              -10.2667, 40.1833, 'Mtwara Region'],
  ['Kigoma town',               -4.8769, 29.6267, 'Kigoma'],
  ['Chake Chake, Pemba',        -5.2456, 39.7666, 'Kusini Pemba'],
  ['Songea',                   -10.6833, 35.6500, 'Ruvuma'],
  ['Iringa town',               -7.7700, 35.6900, 'Iringa'],
  ['Sumbawanga',                -7.9667, 31.6167, 'Rukwa'],
  ['Bukoba',                    -1.3316, 31.8121, 'Kagera'],
  // Songwe region was created in 2016 by splitting Mbeya. The 2015 boundaries
  // do not know it exists, so these must not come back as Mbeya.
  ['Vwawa, Songwe',             -9.1000, 32.9333, 'Songwe'],
  ['Tunduma, Songwe',           -9.3000, 32.7667, 'Songwe'],
];

let pass = 0, fail = 0;
console.log('point-in-polygon resolution\n');
for (const [name, lat, lng, want] of CASES) {
  const t0 = process.hrtime.bigint();
  const r = resolve(lng, lat);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (!r) { console.log(`  FAIL ${name}: no result`); fail++; continue; }
  const ok = r.region === want;
  ok ? pass++ : fail++;
  const edge = r.ward.g ? Math.round(distToBoundary(lng, lat, r.ward.g)) : '?';
  const src = r.ward.s || '?';
  const g = guessVillage(r.ward, lng, lat);
  const located = (r.ward.c || []).filter(Boolean).length;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(26)} ${r.region} / ${r.ward.d} / ${r.ward.w} / ` +
    (g ? `${g.name} (${fmtDist(g.d)})` : '[no village coords]')
  );
  console.log(`         ${r.ward.v.length} villages, ${located} located, ${edge}m to ward edge, ` +
              `src=${src}, ${r.exact ? 'exact' : 'NEAREST'}, ${ms.toFixed(0)}ms`);
  if (!ok) console.log(`       expected region ${want}`);
}

// A point well outside Tanzania (Nairobi) must not resolve.
const out = resolve(36.8219, -1.2921);
const outOk = !out || !out.exact;
console.log(`\n  ${outOk ? 'ok  ' : 'FAIL'} Nairobi rejected (no exact ward match)`);
outOk ? pass++ : fail++;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
