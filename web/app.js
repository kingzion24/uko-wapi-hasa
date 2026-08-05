/* Uko Wapi? — GPS -> region / district / ward, then the user picks their village.
 *
 * Everything runs in the browser. No backend, no login, no data leaves the phone.
 *
 * Lookup path:
 *   index.json (3 KB) -> regions.json (93 KB) -> wards/<slug>.json (~100 KB)
 * so a visitor downloads only their own region's wards.
 */
const DATA = 'data/';
const $ = (id) => document.getElementById(id);

let INDEX = null, REGIONS = null;
const wardCache = new Map();
let map, marker, accCircle, wardLayer, villageMarker;
let current = null; // {region, district, ward, villages}

/* ---------- data loading ---------- */

async function json(path) {
  const r = await fetch(DATA + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function getIndex() { return INDEX ??= await json('index.json'); }
async function getRegions() { return REGIONS ??= await json('regions.json'); }
async function getWards(slug) {
  if (!wardCache.has(slug)) wardCache.set(slug, json(`wards/${slug}.json`));
  return wardCache.get(slug);
}

/* Geometry helpers (inBbox, pointInGeom, distToBoundary) come from geo.js. */

/* ---------- resolution ---------- */

async function candidateRegions(lng, lat) {
  const idx = await getIndex();
  const out = [];
  try {
    const regions = await getRegions();
    for (const f of regions.features) {
      if (pointInGeom(lng, lat, f.geometry)) out.push(f.properties.slug);
    }
  } catch (e) { /* fall through to bbox search */ }
  // Region outlines are simplified, so near a border there may be no hit.
  for (const e of idx) {
    if (!out.includes(e.slug) && inBbox(lng, lat, e.bbox)) out.push(e.slug);
  }
  return out;
}

async function resolve(lng, lat) {
  for (const slug of await candidateRegions(lng, lat)) {
    const file = await getWards(slug);
    const hit = file.wards.find((w) => w.g && inBbox(lng, lat, w.b) && pointInGeom(lng, lat, w.g));
    if (hit) return { region: file.region, slug, ward: hit, exact: true };
  }
  // No polygon contains the point: fall back to the nearest ward boundary,
  // which covers the 1.6% of wards with no polygon and simplification gaps.
  let best = null;
  for (const slug of await candidateRegions(lng, lat)) {
    const file = await getWards(slug);
    for (const w of file.wards) {
      if (!w.g) continue;
      const d = distToBoundary(lng, lat, w.g);
      if (!best || d < best.dist) best = { region: file.region, slug, ward: w, dist: d, exact: false };
    }
  }
  return best;
}

// Other wards whose boundary falls inside the GPS uncertainty radius.
async function nearbyWards(lng, lat, slug, chosen, radius) {
  const file = await getWards(slug);
  const out = [];
  for (const w of file.wards) {
    if (!w.g || w === chosen) continue;
    if (!inBbox(lng, lat, [w.b[0] - 0.05, w.b[1] - 0.05, w.b[2] + 0.05, w.b[3] + 0.05])) continue;
    const d = distToBoundary(lng, lat, w.g);
    if (d <= radius) out.push({ w, d, region: file.region });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, 5);
}

/* ---------- map ---------- */

function showMap(lat, lng, acc, geom, guess) {
  if (!map) {
    map = L.map('map', { attributionControl: false }).setView([lat, lng], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    L.control.attribution({ prefix: false }).addTo(map);
  }
  if (marker) marker.remove();
  if (accCircle) accCircle.remove();
  if (wardLayer) wardLayer.remove();
  if (villageMarker) villageMarker.remove();

  if (guess) {
    villageMarker = L.circleMarker([guess.c[1], guess.c[0]], {
      radius: 5, color: '#b45309', weight: 2, fillColor: '#f59e0b', fillOpacity: 1,
    }).addTo(map).bindTooltip(guess.name, { permanent: true, direction: 'top', className: 'vt' });
  } else {
    villageMarker = null;
  }

  if (geom) {
    wardLayer = L.geoJSON(geom, { style: { color: '#1f7a4d', weight: 2, fillOpacity: 0.12 } }).addTo(map);
  }
  accCircle = L.circle([lat, lng], { radius: acc, color: '#3b82f6', weight: 1, fillOpacity: 0.12 }).addTo(map);
  marker = L.circleMarker([lat, lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);

  const bounds = wardLayer ? wardLayer.getBounds().extend(accCircle.getBounds()) : accCircle.getBounds();
  map.fitBounds(bounds, { padding: [18, 18], maxZoom: 15 });
  setTimeout(() => map.invalidateSize(), 60);
}

/* ---------- rendering ---------- */

/* About half of all villages/mitaa have a coordinate (from OSM place nodes), so
 * where we can, name the closest one and preselect it; the rest of the ward's
 * villages stay available underneath. Returns the best guess, or null. */
function fillVillages(sel, ward, lng, lat) {
  sel.innerHTML = '';
  const coords = ward.c || [];
  const items = ward.v.map((name, i) => ({ name, c: coords[i] || null }));
  const known = items
    .filter((x) => x.c)
    .map((x) => ({ ...x, d: distMeters(lng, lat, x.c[0], x.c[1]) }))
    .sort((a, b) => a.d - b.d);
  const rest = items.filter((x) => !x.c).sort((a, b) => a.name.localeCompare(b.name));

  // Wards from a region data.json does not cover (Songwe) have no village list.
  if (!items.length) {
    sel.add(new Option('— hatuna orodha ya vijiji —', ''));
    sel.disabled = true;
    return null;
  }
  sel.disabled = false;

  if (!known.length) {
    if (items.length > 1) sel.add(new Option(`— chagua kati ya ${items.length} —`, ''));
    rest.forEach((x) => sel.add(new Option(x.name, x.name)));
    if (items.length === 1) sel.value = items[0].name;
    return null;
  }

  const near = document.createElement('optgroup');
  near.label = 'Karibu na wewe / Nearest';
  known.forEach((x) => near.append(new Option(`${x.name} — ${fmtDist(x.d)}`, x.name)));
  sel.add(near);
  if (rest.length) {
    const other = document.createElement('optgroup');
    other.label = 'Nyingine katika kata hii / Others in this ward';
    rest.forEach((x) => other.append(new Option(x.name, x.name)));
    sel.add(other);
  }
  sel.value = known[0].name;
  return known[0];
}

function statement() {
  const v = $('f-village').value;
  return [
    `Mkoa: ${current.region}`,
    `Wilaya: ${current.district}`,
    `Kata/Shehia: ${current.ward}`,
    `Kijiji/Mtaa: ${v || '(hujachagua)'}`,
  ].join('\n');
}

async function render(res, lat, lng, acc) {
  const w = res.ward;
  current = { region: res.region, district: w.d, ward: w.w };

  $('f-region').textContent = res.region;
  $('f-district').textContent = w.d;
  $('f-ward').textContent = w.w;

  const guess = fillVillages($('f-village'), w, lng, lat);
  if (guess) {
    $('v-note').innerHTML = `Tumekisia <strong>${guess.name}</strong> — kituo chake kiko
      ${fmtDist(guess.d)} kutoka ulipo. Badilisha kama si sahihi.
      <span class="en">Best guess by distance — change it if that's not right.</span>`;
  } else if (!w.v.length) {
    $('v-note').innerHTML = `Orodha yetu ya vijiji haijumuishi kata hii bado, hivyo jaza
      kijiji/mtaa mwenyewe kwenye fomu yako.
      <span class="en">Our village list does not cover this ward yet — fill the
      village/mtaa in yourself.</span>`;
  } else {
    $('v-note').innerHTML = `Hatuna ramani ya vijiji vya kata hii. Chagua chako kwenye orodha.
      <span class="en">No village coordinates for this ward — pick yours from the list.</span>`;
  }

  // Say which boundary set answered, and how old it is.
  const year = w.s === '2015' ? 2015 : 2018;
  const age = new Date().getFullYear() - year;
  $('src-note').innerHTML = w.s === '2018'
    ? `Mipaka ya kata: Ofisi ya Taifa ya Takwimu (NBS), mwaka 2018 — miaka ${age} iliyopita.
       ${w.p ? `Msimbo rasmi: <strong>${w.p}</strong>.` : ''}
       <span class="en">Ward boundary from the 2018 national statistics dataset.</span>`
    : `Mipaka ya kata hii ni ya OpenStreetMap mwaka 2015 — miaka ${age} iliyopita, kwa sababu
       haipatikani kwenye seti ya 2018. Hakiki kama kata yako iligawanywa hivi karibuni.
       <span class="en">This ward falls back to the older 2015 boundary.</span>`;

  const note = $('v-note').innerHTML;
  $('f-village').onchange = (e) => {
    $('v-note').innerHTML = (guess && e.target.value !== guess.name)
      ? `Umechagua <strong>${e.target.value}</strong> mwenyewe.
         <span class="en">Your own choice, not our guess.</span>`
      : note;
  };

  $('coords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}  ±${Math.round(acc)} m`;
  $('result').hidden = false;
  showMap(lat, lng, acc, w.g, guess);

  // Confidence: is the ward edge closer than the GPS error?
  const edge = w.g ? distToBoundary(lng, lat, w.g) : Infinity;
  const warn = $('warn');
  const alts = res.exact ? await nearbyWards(lng, lat, res.slug, w, Math.max(acc, 100)) : [];

  if (acc > 1500) {
    // Typically wifi/IP positioning on a laptop rather than a real GPS fix.
    warn.hidden = false;
    warn.innerHTML = `<strong>Kifaa chako hakikupata GPS halisi.</strong>
      Usahihi ni ±${(acc / 1000).toFixed(1)} km, hivyo kata iliyoonyeshwa inaweza kuwa si sahihi kabisa.
      Tumia simu ukiwa nje kwa usahihi zaidi.
      <span class="en">Accuracy is ±${(acc / 1000).toFixed(1)} km — this is a network estimate,
      not a GPS fix. Verify before using.</span>`;
  } else if (!res.exact) {
    warn.hidden = false;
    warn.innerHTML = `<strong>Hatuna uhakika kamili.</strong>
      Hakuna mpaka wa kata unaokuzunguka hapa — tumekuonyesha kata iliyo karibu zaidi
      (mita ${Math.round(res.dist)}). Hakiki kabla ya kutumia.
      <span class="en">No ward boundary covers this point; showing the nearest ward instead. Please verify.</span>`;
  } else if (edge < acc) {
    warn.hidden = false;
    warn.innerHTML = `<strong>Uko karibu na mpaka wa kata.</strong>
      Mpaka uko mita ${Math.round(edge)} tu, lakini GPS yako ina hitilafu ya ±${Math.round(acc)} m.
      Hakiki kata yako hapa chini.
      <span class="en">You are within the GPS error margin of a ward boundary — check the nearby wards below.</span>`;
  } else {
    warn.hidden = true;
  }

  const box = $('alts');
  if (alts.length) {
    box.hidden = false;
    $('alts-body').innerHTML = '';
    for (const a of alts) {
      const b = document.createElement('button');
      b.innerHTML = `<strong>${a.w.w}</strong> — ${a.w.d} <small>mita ${Math.round(a.d)} kutoka hapa</small>`;
      b.onclick = () => render({ region: a.region, slug: res.slug, ward: a.w, exact: true }, lat, lng, acc);
      $('alts-body').append(b);
    }
  } else {
    box.hidden = true;
  }
}

/* ---------- locate ---------- */

function setStatus(msg, isError) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', !!isError);
}

/* A device with no geolocation API at all can only use the manual picker, so
 * lead with that instead of offering a button that cannot work. */
function adaptToDevice() {
  if (navigator.geolocation) return;
  $('locate').hidden = true;
  $('desk-note').hidden = true;
  setStatus('Kivinjari chako hakiruhusu GPS.', true);
  revealManual(`Kivinjari chako hakina huduma ya GPS, hivyo huwezi kupimwa kiotomatiki.
    Chagua mahali pako hapa chini.
    <span class="en">Your browser has no geolocation support — choose your location below.</span>`);
}

async function locate() {
  const btn = $('locate');
  if (!navigator.geolocation) return adaptToDevice();

  btn.disabled = true;
  btn.classList.add('busy');
  setStatus('Inatafuta mahali ulipo…');

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
      try {
        setStatus('Inalinganisha na mipaka ya kata…');
        const res = await resolve(lng, lat);
        if (!res) {
          setStatus('Mahali hapa hapako ndani ya Tanzania.', true);
          revealManual(`Hatukuweza kukuweka ndani ya mipaka ya Tanzania. Chagua mahali pako hapa chini.
            <span class="en">Your position did not fall inside Tanzania — choose your location below.</span>`);
        } else {
          await render(res, lat, lng, acc);
          setStatus('');
          // A fix this coarse is a network estimate, not GPS; offer the picker
          // alongside the result rather than leaving a shaky answer to stand.
          if (acc > 1500) {
            revealManual(`GPS yako ilikuwa na hitilafu ya ±${(acc / 1000).toFixed(1)} km, hivyo jibu
              lililo juu linaweza kukosea. Ukijua mahali pako, chagua hapa chini.
              <span class="en">That fix was too coarse to trust — set your location manually if you know it.</span>`);
          }
        }
      } catch (e) {
        setStatus('Imeshindikana kupakua data ya kata. Angalia intaneti yako.', true);
        console.error(e);
      } finally {
        btn.disabled = false;
        btn.classList.remove('busy');
      }
    },
    (err) => {
      btn.disabled = false;
      btn.classList.remove('busy');
      const msg = {
        1: 'Umekataa ruhusa ya GPS.',
        2: 'Mahali hapapatikani. Jaribu nje ya jengo.',
        3: 'Muda umeisha. Jaribu tena.',
      }[err.code] || 'Hitilafu ya GPS.';
      setStatus(msg, true);
      const why = {
        1: `Umekataa ruhusa ya GPS. Unaweza kuiruhusu kwenye mipangilio ya kivinjari na kubonyeza
            tena, au chagua mahali pako hapa chini.
            <span class="en">Location permission was denied — allow it and retry, or choose below.</span>`,
        2: `Hatukuweza kupata mahali ulipo — mara nyingi hii hutokea ukiwa ndani ya jengo.
            Jaribu tena ukiwa nje, au chagua mahali pako hapa chini.
            <span class="en">Position unavailable, often indoors — retry outside, or choose below.</span>`,
        3: `Muda wa kutafuta GPS umeisha. Jaribu tena, au chagua mahali pako hapa chini.
            <span class="en">The location request timed out — retry, or choose below.</span>`,
      }[err.code] || `Kuna hitilafu ya GPS. Chagua mahali pako hapa chini.
            <span class="en">Something went wrong with GPS — choose your location below.</span>`;
      revealManual(why);
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}

/* ---------- manual picker (fallback only) ----------
 * The point of the site is that it tells you where you are, so this stays out
 * of sight until the GPS path cannot deliver that. Built on first reveal, so a
 * visitor whose GPS works never pays for it. */

let manualReady = false;

async function revealManual(why) {
  const wrap = $('manual-wrap');
  $('manual-why').innerHTML = why;
  if (!manualReady) {
    try {
      await initManual();
      manualReady = true;
    } catch (e) {
      console.error(e);
      return;
    }
  }
  wrap.hidden = false;
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function initManual() {
  const idx = await getIndex();
  const [mR, mD, mW, mV, mC] = ['m-region', 'm-district', 'm-ward', 'm-village', 'm-copy'].map($);
  const reset = (sel, label) => { sel.innerHTML = ''; sel.add(new Option(label, '')); sel.disabled = true; };

  mR.innerHTML = '';
  mR.add(new Option('— chagua mkoa —', ''));
  idx.forEach((e) => mR.add(new Option(e.region, e.slug)));

  let wards = [];
  mR.onchange = async () => {
    reset(mD, '— chagua wilaya —'); reset(mW, '— chagua kata —'); reset(mV, '— chagua kijiji —');
    mC.disabled = true;
    if (!mR.value) return;
    wards = (await getWards(mR.value)).wards;
    [...new Set(wards.map((w) => w.d))].sort().forEach((d) => mD.add(new Option(d, d)));
    mD.disabled = false;
  };
  mD.onchange = () => {
    reset(mW, '— chagua kata —'); reset(mV, '— chagua kijiji —');
    mC.disabled = true;
    if (!mD.value) return;
    wards.filter((w) => w.d === mD.value).map((w) => w.w).sort()
      .forEach((w) => mW.add(new Option(w, w)));
    mW.disabled = false;
  };
  mW.onchange = () => {
    reset(mV, '— chagua kijiji —');
    mC.disabled = true;
    if (!mW.value) return;
    const w = wards.find((x) => x.d === mD.value && x.w === mW.value);
    w.v.forEach((v) => mV.add(new Option(v, v)));
    mV.disabled = false;
  };
  mV.onchange = () => { mC.disabled = !mV.value; };
  mC.onclick = () => copy(mC, [
    `Mkoa: ${mR.selectedOptions[0].text}`, `Wilaya: ${mD.value}`,
    `Kata/Shehia: ${mW.value}`, `Kijiji/Mtaa: ${mV.value}`,
  ].join('\n'));
}

/* ---------- visitor counter ----------
 * Hosted by a free third-party service, since the site has no backend. It only
 * ever sees a page view — never coordinates. Counts once per browser session,
 * and stays hidden if the service is unreachable rather than showing a broken
 * number. Swap COUNTER_* if the service disappears; nothing else depends on it. */

const COUNTER_HOST = 'https://abacus.jasoncameron.dev';
const COUNTER_NS = 'uko-wapi-hasa';
const COUNTER_KEY = 'visits';

async function showVisits() {
  let first = true;
  try {
    first = !sessionStorage.getItem('counted');
  } catch { /* private mode: just read, don't count */ first = false; }

  try {
    const res = await fetch(`${COUNTER_HOST}/${first ? 'hit' : 'get'}/${COUNTER_NS}/${COUNTER_KEY}`);
    if (!res.ok) return;
    const { value } = await res.json();
    if (typeof value !== 'number') return;
    if (first) { try { sessionStorage.setItem('counted', '1'); } catch { /* ignore */ } }
    $('visits-n').textContent = value.toLocaleString('en-US');
    $('visits').hidden = false;
  } catch { /* offline or service down — leave the counter hidden */ }
}

/* The ward polygons describe Tanzania's 2015 division. Render the age rather
 * than hard-coding it, so the page cannot quietly understate how old it is. */
const BOUNDARY_YEAR = 2015;

function showBoundaryAge() {
  const age = new Date().getFullYear() - BOUNDARY_YEAR;
  document.querySelectorAll('.bnd-age').forEach((el) => { el.textContent = age; });
  return age;
}

/* Per-region data-quality disclosure. Which wards were split after 2018 is
 * unknowable from what we have, so this reports what IS measurable: wards
 * falling back to the older 2015 boundaries, wards with no boundary at all, and
 * wards carried in without a village list. */
function showQuality(idx) {
  const rows = idx
    .map((e) => ({ ...e, bad: e.old + e.nogeo + e.novill }))
    .filter((e) => e.bad)
    .sort((a, b) => b.bad - a.bad);
  const box = $('qtable');
  if (!rows.length) { box.textContent = '—'; return; }

  box.innerHTML = '';
  for (const e of rows) {
    const bits = [];
    if (e.old) bits.push(`<span class="q-old">${e.old} kata: mipaka ya 2015</span>`);
    if (e.nogeo) bits.push(`<span class="q-nogeo">${e.nogeo} kata: hakuna mipaka</span>`);
    if (e.novill) bits.push(`<span class="q-novill">${e.novill} kata: hakuna vijiji</span>`);
    const row = document.createElement('div');
    row.className = 'qrow';
    row.innerHTML = `<span class="qname">${e.region}</span><span class="qbits">${bits.join(' · ')}</span>`;
    box.append(row);
  }
}

/* ---------- misc ---------- */

async function copy(btn, text) {
  const label = btn.innerHTML;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Imenakiliwa ✓';
  } catch {
    btn.textContent = 'Imeshindikana';
  }
  setTimeout(() => { btn.innerHTML = label; }, 1600);
}

$('locate').onclick = locate;
$('again').onclick = locate;
$('copy').onclick = (e) => copy(e.currentTarget, statement());

getIndex().then((idx) => {
  const sum = (k) => idx.reduce((n, e) => n + e[k], 0);
  const pct = (a, b) => `${a.toLocaleString()} / ${b.toLocaleString()} (${Math.round((100 * a) / b)}%)`;
  $('cov').textContent = pct(sum('mapped'), sum('wards'));
  $('cov-v').textContent = pct(sum('located'), sum('villages'));
  showQuality(idx);
}).catch((e) => console.error(e));

showBoundaryAge();
adaptToDevice();
showVisits();

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
