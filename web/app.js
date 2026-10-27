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
let lastRender = null; // {res, lat, lng, acc} of the most recent render(), for re-translating in place
let lastIndex = null; // the loaded index.json, for re-rendering the footer quality table

/* ---------- language ---------- */
// Default is Swahili. LANG mirrors the data-lang attribute the pre-paint
// script in index.html may already have set from localStorage.
let LANG = document.documentElement.getAttribute('data-lang') === 'en' ? 'en' : 'sw';
const isEn = () => LANG === 'en';

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

/* How far the nearest-ward fallback may reach. Legitimate uses of it -- the 45
 * wards with no polygon, and gaps left by simplification -- land within a few
 * hundred metres. Without a cap, a point at sea or over the border returns a
 * confident-looking ward tens of kilometres away. */
const MAX_FALLBACK_M = 10000;

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
  return best && best.dist <= MAX_FALLBACK_M ? best : null;
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

// Leaflet (~160 KB of CSS+JS) is only needed once a result exists, so it's
// fetched lazily on first use rather than blocking the initial page render.
let leafletReady = null;
function loadLeaflet() {
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'vendor/leaflet/leaflet.css';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'vendor/leaflet/leaflet.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return leafletReady;
}

async function showMap(lat, lng, acc, geom, guess) {
  await loadLeaflet();
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
    sel.add(new Option(isEn() ? '— no village list —' : '— hatuna orodha ya vijiji —', ''));
    sel.disabled = true;
    return null;
  }
  sel.disabled = false;

  if (!known.length) {
    if (items.length > 1) {
      sel.add(new Option(isEn() ? `— choose from ${items.length} —` : `— chagua kati ya ${items.length} —`, ''));
    }
    rest.forEach((x) => sel.add(new Option(x.name, x.name)));
    if (items.length === 1) sel.value = items[0].name;
    return null;
  }

  const near = document.createElement('optgroup');
  near.label = isEn() ? 'Nearest' : 'Karibu na wewe';
  known.forEach((x) => near.append(new Option(`${x.name} — ${fmtDist(x.d, LANG)}`, x.name)));
  sel.add(near);
  if (rest.length) {
    const other = document.createElement('optgroup');
    other.label = isEn() ? 'Others in this ward' : 'Nyingine katika kata hii';
    rest.forEach((x) => other.append(new Option(x.name, x.name)));
    sel.add(other);
  }
  sel.value = known[0].name;
  return known[0];
}

/* Labelled fields, for copying into a form box by box. The address-block form
 * lives in geo.js as addressBlock(). */
function statement() {
  const v = $('f-village').value;
  const L = isEn()
    ? { region: 'Region', district: 'District', council: 'Council', ward: 'Ward/Shehia',
        village: 'Village/Mtaa', none: '(not chosen)', pc: 'Postcode' }
    : { region: 'Mkoa', district: 'Wilaya', council: 'Halmashauri', ward: 'Kata/Shehia',
        village: 'Kijiji/Mtaa', none: '(hujachagua)', pc: 'Msimbo wa posta' };
  return [
    `${L.region}: ${current.region}`,
    `${L.district}: ${current.district}`,
    `${L.council}: ${current.council}`,
    `${L.ward}: ${current.ward}`,
    `${L.village}: ${v || L.none}`,
    ...(current.pc ? [`${L.pc}: ${current.pc}`] : []),
  ].join('\n');
}

async function render(res, lat, lng, acc) {
  lastRender = { res, lat, lng, acc };
  const w = res.ward;
  current = { region: res.region, district: w.d, council: w.cn, ward: w.w, pc: w.pc };

  $('f-region').textContent = res.region;
  // The short name is what forms ask for; the full council name underneath is
  // what proves which council it is -- and is the whole point of the 2022
  // rebuild, since Ubungo and Kigamboni did not exist in the older sources.
  $('f-district').innerHTML = `${w.d}<small>${w.cn}</small>`;
  $('f-ward').textContent = w.w;
  const napa = '<a href="https://napa.mawasiliano.go.tz/find-postcode" target="_blank" rel="noopener">NaPA</a>';
  $('f-postcode').innerHTML = w.pc
    ? isEn()
      ? `${w.pc} <small>unofficial — confirm with ${napa} (Government)</small>`
      : `${w.pc} <small>si rasmi — thibitisha ${napa} (Serikali)</small>`
    : isEn()
      ? `<span class="none">none for this ward <small>look up ${napa}</small></span>`
      : `<span class="none">hatuna kwa kata hii <small>tafuta ${napa}</small></span>`;

  const guess = fillVillages($('f-village'), w, lng, lat);
  if (guess) {
    $('v-note').innerHTML = isEn()
      ? `Best guess: <strong>${guess.name}</strong> — its point is ${fmtDist(guess.d, LANG)}
         from where you are. Change it if that's not right.`
      : `Tumekisia <strong>${guess.name}</strong> — kituo chake kiko
         ${fmtDist(guess.d, LANG)} kutoka ulipo. Badilisha kama si sahihi.`;
  } else if (!w.v.length) {
    $('v-note').innerHTML = isEn()
      ? `Our village list does not cover this ward yet — fill the village/mtaa in yourself.`
      : `Orodha yetu ya vijiji haijumuishi kata hii bado, hivyo jaza
         kijiji/mtaa mwenyewe kwenye fomu yako.`;
  } else {
    $('v-note').innerHTML = isEn()
      ? `No village coordinates for this ward — pick yours from the list.`
      : `Hatuna ramani ya vijiji vya kata hii. Chagua chako kwenye orodha.`;
  }

  // Say which boundary set answered, and how old it is.
  const age = new Date().getFullYear() - BOUNDARY_YEAR;
  $('src-note').innerHTML = isEn()
    ? `Ward boundary: ${BOUNDARY_YEAR} Population and Housing Census,
       National Bureau of Statistics (NBS) — ${age} years ago.
       Statistical ward code: <strong>${w.code}</strong> —
       <strong>this is not a postcode.</strong>`
    : `Mipaka ya kata: Sensa ya Watu na Makazi ${BOUNDARY_YEAR},
       Ofisi ya Taifa ya Takwimu (NBS) — miaka ${age} iliyopita.
       Msimbo wa kata wa takwimu: <strong>${w.code}</strong> —
       <strong>huu si msimbo wa posta.</strong>`;

  // Prefill a report with everything needed to diagnose a wrong ward. Users
  // will not think to include coordinates, and without them a report is
  // unactionable.
  const report = [
    'Kata iliyoonyeshwa si sahihi. / The ward shown is wrong.',
    '',
    `Ilionyesha / Reported: ${res.region} / ${w.d} / ${w.w}`,
    `Halmashauri / Council: ${w.cn}`,
    'Sahihi ni / Should be: ',
    '',
    '--- taarifa za kiufundi / technical details ---',
    `coords:   ${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    `accuracy: ±${Math.round(acc)} m`,
    `match:    ${res.exact ? 'inside polygon' : `nearest ward, ${Math.round(res.dist || 0)} m away`}`,
    `boundary: NBS ${BOUNDARY_YEAR} census, ward code ${w.code}`,
    `postcode: ${w.pc || 'none'}`,
    `villages: ${w.v.length} listed, ${(w.c || []).filter(Boolean).length} located`,
  ].join('\n');
  $('report').href = 'mailto:mdendutevin@gmail.com'
    + '?subject=' + encodeURIComponent(`Uko Wapi: kata si sahihi (${w.w})`)
    + '&body=' + encodeURIComponent(report);

  const note = $('v-note').innerHTML;
  $('f-village').onchange = (e) => {
    $('v-note').innerHTML = (guess && e.target.value !== guess.name)
      ? isEn()
        ? `Your own choice: <strong>${e.target.value}</strong> — not our guess.`
        : `Umechagua <strong>${e.target.value}</strong> mwenyewe.`
      : note;
  };

  $('coords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}  ±${Math.round(acc)} m`;
  $('result').hidden = false;
  await showMap(lat, lng, acc, w.g, guess);

  // Confidence: is the ward edge closer than the GPS error?
  const edge = w.g ? distToBoundary(lng, lat, w.g) : Infinity;
  const warn = $('warn');
  const alts = res.exact ? await nearbyWards(lng, lat, res.slug, w, Math.max(acc, 100)) : [];

  if (acc > 1500) {
    // Typically wifi/IP positioning on a laptop rather than a real GPS fix.
    warn.hidden = false;
    warn.innerHTML = isEn()
      ? `<strong>Your device did not get a real GPS fix.</strong>
         Accuracy is ±${(acc / 1000).toFixed(1)} km — this is a network estimate, not a GPS
         fix, so the ward shown could be quite wrong. Use a phone outdoors for accuracy.`
      : `<strong>Kifaa chako hakikupata GPS halisi.</strong>
         Usahihi ni ±${(acc / 1000).toFixed(1)} km, hivyo kata iliyoonyeshwa inaweza kuwa si sahihi kabisa.
         Tumia simu ukiwa nje kwa usahihi zaidi.`;
  } else if (!res.exact) {
    warn.hidden = false;
    warn.innerHTML = isEn()
      ? `<strong>We're not fully certain.</strong>
         No ward boundary covers this point — showing the nearest ward instead
         (${Math.round(res.dist)} m away). Please verify before using it.`
      : `<strong>Hatuna uhakika kamili.</strong>
         Hakuna mpaka wa kata unaokuzunguka hapa — tumekuonyesha kata iliyo karibu zaidi
         (mita ${Math.round(res.dist)}). Hakiki kabla ya kutumia.`;
  } else if (edge < acc) {
    warn.hidden = false;
    warn.innerHTML = isEn()
      ? `<strong>You're close to a ward boundary.</strong>
         The boundary is only ${Math.round(edge)} m away, but your GPS has a ±${Math.round(acc)} m
         margin of error. Check your ward below.`
      : `<strong>Uko karibu na mpaka wa kata.</strong>
         Mpaka uko mita ${Math.round(edge)} tu, lakini GPS yako ina hitilafu ya ±${Math.round(acc)} m.
         Hakiki kata yako hapa chini.`;
  } else {
    warn.hidden = true;
  }

  const box = $('alts');
  if (alts.length) {
    box.hidden = false;
    $('alts-body').innerHTML = '';
    for (const a of alts) {
      const b = document.createElement('button');
      b.innerHTML = isEn()
        ? `<strong>${a.w.w}</strong> — ${a.w.d} <small>${Math.round(a.d)} m from here</small>`
        : `<strong>${a.w.w}</strong> — ${a.w.d} <small>mita ${Math.round(a.d)} kutoka hapa</small>`;
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
  setStatus(isEn() ? 'Your browser does not support GPS.' : 'Kivinjari chako hakiruhusu GPS.', true);
  revealManual(isEn()
    ? `Your browser has no geolocation support, so you can't be located automatically.
       Choose your location below.`
    : `Kivinjari chako hakina huduma ya GPS, hivyo huwezi kupimwa kiotomatiki.
       Chagua mahali pako hapa chini.`);
}

/* A phone's first fix is usually the coarse network one; the GPS chip then
 * refines it over a few seconds, often from ±1500 m to ±10 m. getCurrentPosition
 * hands back whichever arrives first, so watch instead and keep the best
 * reading. Stops early once the fix is good enough to be worth no more waiting.
 *
 * GOOD_ENOUGH_M is well under the 152 m radius of the smallest ward in the
 * country, so a fix this tight resolves even Zanzibar's tightest shehia. */
const GOOD_ENOUGH_M = 25;
const WATCH_MS = 8000;

function bestPosition() {
  return new Promise((resolve, reject) => {
    let best = null, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      navigator.geolocation.clearWatch(id);
      best ? resolve(best) : reject({ code: 3 });
    };
    const timer = setTimeout(finish, WATCH_MS);
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        if (best.coords.accuracy <= GOOD_ENOUGH_M) finish();
        else setStatus(isEn()
          ? `Improving accuracy… ±${Math.round(best.coords.accuracy)} m`
          : `Inaboresha usahihi… ±${Math.round(best.coords.accuracy)} m`);
      },
      (err) => { if (!best) { done = true; clearTimeout(timer); navigator.geolocation.clearWatch(id); reject(err); } },
      { enableHighAccuracy: true, timeout: WATCH_MS, maximumAge: 0 }
    );
  });
}

async function locate() {
  const btn = $('locate');
  if (!navigator.geolocation) return adaptToDevice();

  btn.disabled = true;
  btn.classList.add('busy');
  $('outside').hidden = true;
  setStatus(isEn() ? 'Finding your location…' : 'Inatafuta mahali ulipo…');

  bestPosition().then(
    async (pos) => {
      const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
      try {
        setStatus(isEn() ? 'Matching it against ward boundaries…' : 'Inalinganisha na mipaka ya kata…');
        const res = await resolve(lng, lat);
        if (!res) {
          setStatus('');
          $('result').hidden = true;
          $('outside').hidden = false;
          $('outside').scrollIntoView({ behavior: 'smooth', block: 'start' });
          // Diaspora filling forms for home is a real use, so open the lookup --
          // but framed as looking a place up, not as fixing a failed fix.
          await ensureManual();
          $('lookup').open = true;
        } else {
          await render(res, lat, lng, acc);
          setStatus('');
          btn.classList.add('success');
          setTimeout(() => btn.classList.remove('success'), 500);
          // A fix this coarse is a network estimate, not GPS; offer the picker
          // alongside the result rather than leaving a shaky answer to stand.
          if (acc > 1500) {
            revealManual(isEn()
              ? `Your GPS fix had an error of ±${(acc / 1000).toFixed(1)} km, so the result above
                 could be wrong. If you know your location, choose it below.`
              : `GPS yako ilikuwa na hitilafu ya ±${(acc / 1000).toFixed(1)} km, hivyo jibu
                 lililo juu linaweza kukosea. Ukijua mahali pako, chagua hapa chini.`);
          }
        }
      } catch (e) {
        setStatus(isEn()
          ? 'Could not download ward data. Check your internet connection.'
          : 'Imeshindikana kupakua data ya kata. Angalia intaneti yako.', true);
        console.error(e);
      } finally {
        btn.disabled = false;
        btn.classList.remove('busy');
      }
    },
    (err) => {
      btn.disabled = false;
      btn.classList.remove('busy');
      const msg = isEn()
        ? { 1: 'You denied GPS permission.', 2: 'Location unavailable. Try outdoors.', 3: 'Timed out. Try again.' }[err.code]
          || 'GPS error.'
        : { 1: 'Umekataa ruhusa ya GPS.', 2: 'Mahali hapapatikani. Jaribu nje ya jengo.', 3: 'Muda umeisha. Jaribu tena.' }[err.code]
          || 'Hitilafu ya GPS.';
      setStatus(msg, true);
      const why = isEn()
        ? {
            1: `You denied GPS permission. You can allow it in your browser settings and
                retry, or choose your location below.`,
            2: `We couldn't get your location — this often happens indoors. Retry
                outside, or choose your location below.`,
            3: `The GPS request timed out. Retry, or choose your location below.`,
          }[err.code] || `Something went wrong with GPS. Choose your location below.`
        : {
            1: `Umekataa ruhusa ya GPS. Unaweza kuiruhusu kwenye mipangilio ya kivinjari na kubonyeza
                tena, au chagua mahali pako hapa chini.`,
            2: `Hatukuweza kupata mahali ulipo — mara nyingi hii hutokea ukiwa ndani ya jengo.
                Jaribu tena ukiwa nje, au chagua mahali pako hapa chini.`,
            3: `Muda wa kutafuta GPS umeisha. Jaribu tena, au chagua mahali pako hapa chini.`,
          }[err.code] || `Kuna hitilafu ya GPS. Chagua mahali pako hapa chini.`;
      revealManual(why);
    }
  );
}

/* ---------- manual picker (fallback only) ----------
 * The point of the site is that it tells you where you are, so this stays out
 * of sight until the GPS path cannot deliver that. Built on first reveal, so a
 * visitor whose GPS works never pays for it. */

let manualReady = false;

async function ensureManual() {
  if (manualReady) return true;
  try {
    await initManual();
    manualReady = true;
  } catch (e) {
    console.error(e);
    return false;
  }
  return true;
}

/* GPS could not answer: open the lookup and say why. Same component the user
 * can open deliberately, but framed as a rescue rather than a browse. */
async function revealManual(why) {
  if (!(await ensureManual())) return;
  const box = $('lookup');
  $('manual-why').innerHTML = why;
  $('manual-why').hidden = false;
  $('lookup-hint').hidden = true;
  box.classList.add('urgent');
  box.open = true;
  $('manual-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function initManual() {
  const idx = await getIndex();
  const [mR, mD, mW, mV, mC] = ['m-region', 'm-district', 'm-ward', 'm-village', 'm-copy'].map($);
  const reset = (sel, label) => { sel.innerHTML = ''; sel.add(new Option(label, '')); sel.disabled = true; };
  const ph = () => isEn()
    ? { region: '— choose a region —', district: '— choose a district —', ward: '— choose a ward —',
        village: '— choose a village —', novill: '— no village list —' }
    : { region: '— chagua mkoa —', district: '— chagua wilaya —', ward: '— chagua kata —',
        village: '— chagua kijiji —', novill: '— hatuna orodha ya vijiji —' };

  mR.innerHTML = '';
  mR.add(new Option(ph().region, ''));
  idx.forEach((e) => mR.add(new Option(e.region, e.slug)));

  let wards = [], picked = null;
  mR.onchange = async () => {
    reset(mD, ph().district); reset(mW, ph().ward); reset(mV, ph().village);
    mC.disabled = true; picked = null; $('m-out').hidden = true;
    if (!mR.value) return;
    wards = (await getWards(mR.value)).wards;
    [...new Set(wards.map((w) => w.d))].sort((a, b) => a.localeCompare(b))
      .forEach((d) => mD.add(new Option(d, d)));
    mD.disabled = false;
  };
  mD.onchange = () => {
    reset(mW, ph().ward); reset(mV, ph().village);
    mC.disabled = true; picked = null; $('m-out').hidden = true;
    if (!mD.value) return;
    wards.filter((w) => w.d === mD.value).map((w) => w.w).sort()
      .forEach((w) => mW.add(new Option(w, w)));
    mW.disabled = false;
  };
  mW.onchange = () => {
    reset(mV, ph().village);
    mC.disabled = true;
    picked = null;
    $('m-out').hidden = true;
    if (!mW.value) return;
    const w = wards.find((x) => x.d === mD.value && x.w === mW.value);
    picked = w;
    // The postcode is a property of the ward, so it can be shown before a
    // village is picked -- often it is the only thing the visitor came for.
    $('m-council').textContent = w.cn;
    $('m-postcode').innerHTML = w.pc
      ? isEn() ? `${w.pc} <small>unofficial — confirm with NaPA (Government)</small>`
               : `${w.pc} <small>si rasmi — thibitisha NaPA (Serikali)</small>`
      : isEn() ? `<span class="none">none for this ward <small>look up NaPA</small></span>`
               : `<span class="none">hatuna kwa kata hii <small>tafuta NaPA</small></span>`;
    $('m-out').hidden = false;
    if (!w.v.length) {
      mV.innerHTML = '';
      mV.add(new Option(ph().novill, ''));
      mV.disabled = true;
      mC.disabled = false;   // region/district/ward/postcode are still worth copying
      return;
    }
    w.v.forEach((v) => mV.add(new Option(v, v)));
    mV.disabled = false;
  };
  mV.onchange = () => { mC.disabled = !mV.value; };
  mC.onclick = () => {
    const L = isEn()
      ? { region: 'Region', district: 'District', council: 'Council', ward: 'Ward/Shehia',
          village: 'Village/Mtaa', none: '(no list)', pc: 'Postcode' }
      : { region: 'Mkoa', district: 'Wilaya', council: 'Halmashauri', ward: 'Kata/Shehia',
          village: 'Kijiji/Mtaa', none: '(hatuna orodha)', pc: 'Msimbo wa posta' };
    copy(mC, [
      `${L.region}: ${mR.selectedOptions[0].text}`, `${L.district}: ${mD.value}`,
      ...(picked ? [`${L.council}: ${picked.cn}`] : []),
      `${L.ward}: ${mW.value}`,
      `${L.village}: ${mV.value || L.none}`,
      ...(picked && picked.pc ? [`${L.pc}: ${picked.pc}`] : []),
    ].join('\n'));
  };
}

/* ---------- visitor counter ----------
 * Hosted by a free third-party service, since the site has no backend. It only
 * ever sees a page view — never coordinates. Counts once per browser session,
 * and stays hidden if the service is unreachable rather than showing a broken
 * number. Swap COUNTER_* if the service disappears; nothing else depends on it. */

const COUNTER_HOST = 'https://abacus.jasoncameron.dev';
const COUNTER_NS = 'uko-wapi-hasa';
const COUNTER_KEY = 'visits';

// Headless browsers and JS-rendering crawlers (Googlebot, Lighthouse, Puppeteer)
// start with empty sessionStorage every time, so they would count on every visit.
const IS_BOT = navigator.webdriver ||
  /bot|crawl|spider|slurp|headless|lighthouse|preview/i.test(navigator.userAgent);

async function showVisits() {
  let first = !IS_BOT;
  try {
    first = first && !sessionStorage.getItem('counted');
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

/* The ward polygons and the whole region/council/ward hierarchy come from the
 * 2022 Population and Housing Census. Render the age rather than hard-coding
 * it, so the page cannot quietly understate how old it is. */
const BOUNDARY_YEAR = 2022;

function showBoundaryAge() {
  const age = new Date().getFullYear() - BOUNDARY_YEAR;
  document.querySelectorAll('.bnd-age').forEach((el) => { el.textContent = age; });
  return age;
}

/* Per-region data-quality disclosure. Every ward now has an official boundary
 * and council, so the remaining gaps are in the two things NBS does not publish
 * at this level: the village/mtaa list and the postcode. Both come from older
 * sources joined on by name, so coverage is uneven and worth showing. */
function showQuality(idx) {
  const rows = idx
    .map((e) => ({ ...e, bad: e.novill + (e.wards - e.pc) }))
    .filter((e) => e.bad)
    .sort((a, b) => b.bad - a.bad);
  const box = $('qtable');
  if (!rows.length) { box.textContent = '—'; return; }

  box.innerHTML = '';
  for (const e of rows) {
    const bits = [];
    if (e.novill) {
      bits.push(isEn()
        ? `<span class="q-novill">${e.novill}/${e.wards} wards: no village list</span>`
        : `<span class="q-novill">${e.novill}/${e.wards} kata: hakuna orodha ya vijiji</span>`);
    }
    const noPc = e.wards - e.pc;
    if (noPc) {
      bits.push(isEn()
        ? `<span class="q-nopc">${noPc}/${e.wards} wards: no postcode</span>`
        : `<span class="q-nopc">${noPc}/${e.wards} kata: hakuna msimbo wa posta</span>`);
    }
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
    btn.textContent = isEn() ? 'Copied ✓' : 'Imenakiliwa ✓';
  } catch {
    btn.textContent = isEn() ? 'Failed' : 'Imeshindikana';
  }
  setTimeout(() => { btn.innerHTML = label; }, 1600);
}

/* ---------- theme ---------- */

// Default is light. A visitor's explicit choice is remembered and applied
// before paint by the inline script in index.html; this just keeps the
// toggle, aria state and browser-chrome colors in sync with it.
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-toggle').setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
  $('meta-theme-color').setAttribute('content', theme === 'dark' ? '#101317' : '#1f7a4d');
  $('meta-color-scheme').setAttribute('content', theme);
}
applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

$('theme-toggle').onclick = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch (e) {}
  applyTheme(next);
};

/* ---------- language ---------- */

// Default is Swahili. A visitor's explicit choice is remembered and applied
// before paint by the inline script in index.html (which also sets the
// data-lang attribute LANG was seeded from). Static bilingual pairs in the
// HTML (.t-sw / .en) are shown or hidden purely by CSS keyed off that
// attribute; this only keeps the toggle's aria state in sync and re-renders
// whatever dynamic (JS-generated) text is currently on screen.
function applyLang(lang) {
  LANG = lang;
  document.documentElement.setAttribute('data-lang', lang);
  document.documentElement.lang = lang;
  $('lang-toggle').setAttribute('aria-pressed', lang === 'en' ? 'true' : 'false');
  if (lastRender) render(lastRender.res, lastRender.lat, lastRender.lng, lastRender.acc);
  if (manualReady) initManual();
  if (lastIndex) showQuality(lastIndex);
}
$('lang-toggle').setAttribute('aria-pressed', LANG === 'en' ? 'true' : 'false');

$('lang-toggle').onclick = () => {
  const next = LANG === 'en' ? 'sw' : 'en';
  try { localStorage.setItem('lang', next); } catch (e) {}
  applyLang(next);
};

$('locate').onclick = locate;
$('again').onclick = locate;
$('copy').onclick = (e) => copy(e.currentTarget, statement());
$('copy-addr').onclick = (e) => copy(e.currentTarget, addressBlock(current, $('f-village').value, LANG));

getIndex().then((idx) => {
  lastIndex = idx;
  const sum = (k) => idx.reduce((n, e) => n + e[k], 0);
  const pct = (a, b) => `${a.toLocaleString()} / ${b.toLocaleString()} (${Math.round((100 * a) / b)}%)`;
  $('cov').textContent = pct(sum('mapped'), sum('wards'));
  $('cov-v').textContent = pct(sum('located'), sum('villages'));
  $('cov-pc').textContent = pct(sum('pc'), sum('wards'));
  $('cov-vw').textContent = pct(sum('wards') - sum('novill'), sum('wards'));
  showQuality(idx);
}).catch((e) => console.error(e));

$('lookup').addEventListener('toggle', () => { if ($('lookup').open) ensureManual(); });

showBoundaryAge();
adaptToDevice();
showVisits();

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
