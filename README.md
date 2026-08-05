
# Uko Wapi? — Tanzania location finder

`data.json` is a list of Tanzania's administrative units down to village/street
level: **30 regions → 169 districts → 3,641 wards/shehia → 16,408
villages/mitaa**.

`web/` is a small static site built on top of it. You tap one button, it reads
your GPS, and it tells you which region, district and ward you are in, then
names the closest village/mtaa for you to confirm. The point is to stop people
typing the wrong thing into forms.

No login, no backend, no accounts. Everything runs in the browser and no
location data leaves the phone.

Live at **https://ukowapi.site**

## Run it

```bash
cd web && python3 -m http.server 8777
# open http://localhost:8777
```

Geolocation needs `localhost` or HTTPS — it will **not** work over plain
`http://` on a LAN address, so testing from a phone means deploying first.

## Deployment

Pushing to `master` publishes the site:
`.github/workflows/deploy.yml` runs the test suite, then uploads `web/` to
GitHub Pages. Nothing is rebuilt in CI — `web/data/` is committed, and the
workflow only verifies that what is committed is self-consistent.

The heavy rebuild (geoBoundaries + Overpass downloads) is a local task; see
[Rebuilding the data](#rebuilding-the-data).

Custom domain: `web/CNAME` holds `ukowapi.site`. It must live in `web/`, since
that directory is what gets uploaded as the Pages artifact — a CNAME at the
repo root would never be published. Pages must be set to
**Settings → Pages → Source: GitHub Actions**; the "deploy from a branch"
option cannot work here, because it only offers `/` or `/docs` and the site
lives in `web/`.

## How the lookup works

`data.json` has no coordinates, so ward boundary polygons come from
[geoBoundaries](https://www.geoboundaries.org/) ADM3 (sourced from
OpenStreetMap). The build joins those polygons to the names in `data.json`.

At runtime the browser loads:

| File                         | Size                     | When             |
| ---------------------------- | ------------------------ | ---------------- |
| `data/index.json`          | 4 KB                     | on page load     |
| `data/regions.json`        | 93 KB                    | on first locate  |
| `data/wards/<region>.json` | 88 KB median, 165 KB max | only your region |

So a visitor downloads roughly 185 KB, not the 47 MB of raw boundary data.
Point-in-polygon resolution takes 1–4 ms. A service worker caches everything,
so it works offline after the first visit, and a web manifest makes it
installable to a home screen.

## Device handling

- **Touch devices** get 44 px minimum hit areas, and selects use a 16 px font
  so iOS Safari does not zoom the page when one is focused.
- **Narrow phones** stack field labels above values; wider screens get a
  roomier column and a taller map; short landscape screens cap the map height.
- **Desktops** are told that location there is estimated from the network, and
  any fix worse than 1.5 km warns that it is a network estimate, not GPS —
  laptops routinely report ±5 km over wifi, which would otherwise produce a
  confident but wrong ward.
- **No geolocation API** hides the button and opens the manual picker instead
  of offering something that cannot work.
- Honours `prefers-reduced-motion`; printing hides the map and buttons.

## Accuracy, and what this is not

`data.json` has exactly four levels, and `Village_Mtaa` **is** the street level —
in towns its values are mitaa (`Kariakoo Mashariki`, `Mission Quarter`), in the
countryside they are villages. There is no fifth, finer field.

**Region, district and ward are decided by the polygon. The village/mtaa is a
best guess you confirm.** No village boundaries are published as open data
anywhere, so the app instead gives each village a point (from OSM place nodes,
place areas and low-level admin boundaries), names the closest one, and
preselects it. You can always override it.

The app is explicit about uncertainty:

- **3,583 of 3,641 wards (98.4%) have a polygon.** The remaining 58 are wards
  renamed or split after the 2015 OSM boundary snapshot. If your point falls in
  one, the app shows the nearest ward and says so.
- **8,647 of 16,408 villages (52.7%) have a coordinate**, and coverage is very
  uneven — see below. Where a ward has none, the app says so and just shows the
  list.
- If the GPS accuracy radius is wider than your distance to the ward boundary,
  it warns you and lists the neighbouring wards so you can correct it.
- A manual region → district → ward → village picker covers denied permission,
  being indoors, desktop use, or filling a form for someone else.

### Village coverage is worst where it matters most

OSM maps rural villages as `place=*` nodes, but urban mitaa are barely mapped at
all. Coverage by region:

| | Villages located |
|---|---|
| Rural mainland (Shinyanga, Simiyu, Kigoma, Geita…) | 65–79% |
| Mid (Morogoro, Lindi, Arusha, Iringa, Tanga) | 46–52% |
| Mbeya, Rukwa, **Dar es Salaam** | 28–35% |
| **Zanzibar** (all five regions) | **1.5–6.7%** |

Adding OSM place *areas* and admin boundaries on top of place nodes only moved
the total from 51.7% to 52.7% — the urban data simply isn't in OSM. In Dar and
Zanzibar the app therefore falls back to the plain dropdown for most wards.
Closing that gap needs a different source (a survey, or crowd-sourced picks
logged over time), not a better query.

This is a **form-filling aid, not proof of residence.** Browser GPS is
±5–50 m at best and is trivially spoofed, and the page has no identity check —
anyone can produce any result. Don't treat its output as evidence.

## Rebuilding the data

```bash
bash build/build.sh
```

Downloads geoBoundaries ADM1/2/3, joins them to `data.json`, simplifies the
polygons with mapshaper, writes `web/data/`, and runs the tests. Needs
`python3`, `node`/`npx` and `curl`.

| Script                 | Does                                                   |
| ---------------------- | ------------------------------------------------------ |
| `build/link.py`      | Joins ward polygons to`data.json` names              |
| `build/villages.py`  | Gives villages/mitaa a coordinate from OSM             |
| `build/web_data.py`  | Splits into per-region files for the web app           |
| `build/test_geo.js`  | Resolves 16 known towns + rejects Nairobi              |
| `build/test_data.js` | Verifies`web/data` round-trips `data.json` exactly |

### The join

ADM3 features carry only a ward name, and ward names are not unique nationally,
so each ward's parent is derived spatially before matching the name. Two things
made this fiddly:

- **Name variants.** `Levolosi`/`Levolos`, `Gongolamboto`/`Gongo la Mboto`,
  `Usariver`/`Usa River`, plus ~2,000 wards where `data.json` appends
  `" Ward"`/`" Shehia"`. Handled by normalisation plus a fuzzy match with a
  minimum score of 88.
- **Wrong parents near borders.** The ADM1 and ADM2 layers disagree slightly
  around Dar es Salaam and Arusha, putting Ilala in Pwani and Monduli in
  Manyara. A ward that fails to match in its assigned region falls back to a
  national name search and is accepted when the name resolves unambiguously.

Result: 3,597 of 3,644 polygons linked (3,496 exact, 101 fuzzy).

One row of `data.json` (`Mara / Musoma / <blank> / Mikuyu`) has a blank ward and
is dropped at build time, so it cannot become an empty form field.

## Visitor counter

The footer shows a page-view count from
[abacus](https://abacus.jasoncameron.dev) (namespace `uko-wapi-hasa`, key
`visits`) — a free, no-signup counter, since the site has no backend of its own.

- It counts **once per browser session** (`sessionStorage`), not once per reload.
- It sends **only a page view**. Coordinates never leave the browser, and the
  footer disclaimer says so explicitly.
- If the service is down or the visitor is offline, the counter **stays hidden**
  rather than showing a broken number.
- To swap services, change `COUNTER_HOST` / `COUNTER_NS` / `COUNTER_KEY` at the
  top of the counter section in `web/app.js`. Nothing else depends on it.

These free counters do disappear — `counterapi.dev` was returning database
errors while this was being built. Treat the number as decorative. For real
analytics use [GoatCounter](https://www.goatcounter.com/) (free, cookieless).

## Attribution

Ward boundaries: [geoBoundaries](https://www.geoboundaries.org/) ADM3, derived
from OpenStreetMap, licensed **ODbL 1.0** — if you redistribute or build on
`web/data/`, that licence and its attribution requirement come with it.
Map tiles: OpenStreetMap.
