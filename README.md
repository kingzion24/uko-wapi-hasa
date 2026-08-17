
# Uko Wapi? — Tanzania location finder

The app serves Tanzania's current administrative division, from the **2022
Population and Housing Census**: **31 regions → 195 councils → 4,344
wards/shehia**, every one with an official boundary and code.

`data.json`, this repo's original contents, is an older list down to village
level (**30 regions → 169 districts → 3,641 wards → 16,408 villages/mitaa**). It
no longer defines the hierarchy — it only supplies the village/mtaa lists, which
NBS does not publish at this level.

`web/` is a small static site built on top of it. You tap one button, it reads
your GPS, and it tells you which region, district and ward you are in, then
names the closest village/mtaa for you to confirm. The point is to stop people
typing the wrong thing into forms.

No login, no backend, no accounts. Nothing is stored and your coordinates are
never transmitted anywhere. One caveat, stated on the page too: fetching map
tiles tells OpenStreetMap roughly where you are, as on any site with a map.

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

The heavy rebuild (NBS shapefile + Overpass downloads) is a local task; see
[Rebuilding the data](#rebuilding-the-data).

Custom domain: `web/CNAME` holds `ukowapi.site`. It must live in `web/`, since
that directory is what gets uploaded as the Pages artifact — a CNAME at the
repo root would never be published. Pages must be set to
**Settings → Pages → Source: GitHub Actions**; the "deploy from a branch"
option cannot work here, because it only offers `/` or `/docs` and the site
lives in `web/`.

## How the lookup works

One source defines the hierarchy and every boundary; two older ones fill in
fields it does not carry.

| Source | Year | Licence | Used for |
|---|---|---|---|
| [NBS 2022 PHC ward shapefile](https://www.nbs.go.tz/statistics/topic/gis) | 2022 | cite NBS | **everything** — 31 regions, 195 councils, 4,344 wards, all polygons |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) place nodes | current | ODbL 1.0 | village/mtaa coordinates — 7,588 (50%) |
| [tanzaniapostcode.com](https://www.tanzaniapostcode.com/) | — | no stated licence | postcodes — 3,053 wards (70.3%) |

Village/mtaa **names** come from `data.json` and are joined to the 2022 wards by
region + ward name; 3,395 of 4,344 wards (78%) match. Where they don't, the ward
still resolves — it simply has no village list.

### The projection trap

The NBS `.prj` says `WGS_1984_World_Mercator`. That is **EPSG:3395, ellipsoidal**
— *not* the EPSG:3857 spherical "Web Mercator" most tooling assumes. Reproject
with the spherical formula and longitude comes out exact while latitude lands
**~5 km north**, which is silent and puts points in the neighbouring ward.
`build/nbs_geojson.py` uses pyproj with an explicit EPSG:3395 and refuses to
write if the result falls outside Tanzania's bounding box.

At runtime the browser loads:

| File                         | Size                     | When             |
| ---------------------------- | ------------------------ | ---------------- |
| `data/index.json`          | 4 KB                     | on page load     |
| `data/regions.json`        | 93 KB                    | on first locate  |
| `data/wards/<region>.json` | 88 KB median, 165 KB max | only your region |

Leaflet is vendored into `web/vendor/` rather than loaded from a CDN, so the
page makes no third-party asset requests and the map works offline.

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
- **No geolocation API** hides the button and reveals the manual fallback
  instead of offering something that cannot work.
- Honours `prefers-reduced-motion`; printing hides the map and buttons.

## How precisely it can place you

Two independent limits decide whether the answer is right.

**The fix.** `navigator.geolocation` reports `coords.accuracy`, a 68%-confidence
radius in metres. A phone's *first* callback is usually the coarse network
estimate; the GPS chip then refines it, often from ±1500 m to ±10 m over a few
seconds. `getCurrentPosition` hands back whichever arrives first, so the app uses
`watchPosition` instead and keeps the best reading, stopping early at **±25 m**
or after **8 s** (`bestPosition()` in `web/app.js`). The status line shows the
radius tightening as it goes.

**Ward size.** From the 2022 polygons:

| | min | p10 | median | p90 |
|---|---|---|---|---|
| area | 0.07 km² | 3.7 km² | 83 km² | 422 km² |
| radius if circular | 152 m | 1.1 km | 5.1 km | 11.6 km |

For a median ward the boundary is ~5 km away and a 20 m fix is decisive. The risk
is concentrated in the **278 wards under 2 km²** (6.4%) — inner Dar and Zanzibar
Stone Town, the smallest about 150 m across, where a 100 m fix genuinely cannot
separate neighbours. The ±25 m target is set below that smallest ward on purpose.

So there is no single accuracy figure. What the app does instead is compare
`distToBoundary()` against `coords.accuracy` on every result and say which case
it is: comfortably inside, within the error margin of an edge (it then lists the
neighbouring wards), or too coarse to trust at all (over 1.5 km, where it opens
the manual picker rather than let a shaky answer stand).

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

- **All 4,344 wards have an official polygon**, so a point inside Tanzania
  resolves exactly. The nearest-ward fallback is capped at 10 km and otherwise
  returns nothing, rather than naming a confident ward 30 km out at sea.
- Each result states **which boundary set answered and how old it is**, plus the
  official NBS ward code.
- **7,588 of 15,183 villages (50%) have a coordinate**, and coverage is very
  uneven — see below. Where a ward has none, the app says so and just shows the
  list.
- If the GPS accuracy radius is wider than your distance to the ward boundary,
  it warns you and lists the neighbouring wards so you can correct it.
- A manual region → district → ward → village picker exists, but **only as a
  fallback**: it stays hidden until GPS is refused, fails, times out, returns a
  fix coarser than 1.5 km, or lands outside Tanzania. The whole point is that
  the site tells you where you are, so offering a manual path as a peer option
  would invite the guessing this is meant to replace — but leaving a
  GPS-denied visitor with a dead page would just lose them. Its dropdowns
  cascade, so even a manual choice cannot produce an invalid
  region/district/ward combination.

### Why the council used to be wrong

Until this rebuild the site derived the district from `data.json`, which lists
**30 regions, no Songwe, and only three Dar es Salaam councils**. That dates it
to 2015 — before **Kigamboni** was split from Temeke (2015), **Ubungo** from
Kinondoni (2016), and before Songwe was split from Mbeya (2016).

So a resident of Kimara was told **Kinondoni**. Kimara has been in Ubungo for a
decade. The 2015 and 2018 boundary sets did not fix it either: the 2018 NBS/OCHA
file still records `adm2 = Kinondoni` for Ubungo ward. Nothing short of the 2022
census had the answer.

The 2022 census file carries `dist_name` and `counc_name` as separate fields, so
the site now shows both the short name a form asks for and the full legal council
name beneath it. `build/test_data.js` pins this as a regression test.

Remaining limits:

- **Wards split after 2022 still resolve to their old parent**, silently. There
  is no missing-polygon signal to warn on — it looks like a clean hit. This is
  the one failure mode the app cannot detect.
- 950 of 4,344 wards get no village list, because `data.json` predates them or
  names them differently.
- NBS reuses **five ward codes** across distinct wards. Nothing is keyed on the
  code; `test_data.js` pins the five so a sixth would fail the build.
- 62 ward names repeat inside a single region. Postcodes for those are dropped
  rather than guessed, since the source URLs cannot tell them apart.

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

Downloads the NBS shapefile and the OSM place data, reprojects, simplifies the
polygons with mapshaper, joins on villages and postcodes, writes `web/data/`, and
runs the tests. Needs `python3`, `node`/`npx` and `curl`.

| Script                  | Does                                                     |
| ----------------------- | -------------------------------------------------------- |
| `build/nbs_geojson.py`  | NBS shapefile → WGS84 GeoJSON (EPSG:3395, bbox-guarded)   |
| `build/names.py`        | Name normalisation shared by every join                   |
| `build/postcodes.py`    | Joins postcodes to wards from the tanzaniapostcode sitemap |
| `build/villages.py`     | Gives villages/mitaa a coordinate from OSM                |
| `build/nbs2022.py`      | Writes the per-region files the web app loads             |
| `build/test_geo.js`     | Towns resolve, foreign points do not, address formatting  |
| `build/test_markup.js`  | Every id app.js uses exists; no third-party assets        |
| `build/test_data.js`    | Structure, containment, national totals, council splits   |

### The join

NBS owns the hierarchy; `data.json` only contributes village names, matched on
region + ward. Ward names are not unique nationally, so the key is always
`(region, ward)`, never ward alone. Two things make it fiddly:

- **Name variants.** `Levolosi`/`Levolos`, `Gongolamboto`/`Gongo la Mboto`,
  `Usariver`/`Usa River`, plus ~2,000 wards where `data.json` appends
  `" Ward"`/`" Shehia"` and NBS does not. That single suffix once cost about 75%
  of all postcode matches. Handled in `build/names.py`.
- **Repeated ward names inside one region.** 62 of them. Where several
  `data.json` wards could feed one NBS ward, only a district agreement is
  accepted; otherwise nothing is attached, because another council's villages
  are worse than no villages.

`test_data.js` enforces **containment, not round-tripping**: every village shown
must exist in `data.json`, but `data.json` may hold wards NBS has since renamed,
merged or split away. Asserting an exact round-trip would now be asserting that
the stale list is right.

## Postcodes

**The authoritative source is the Government's
[NaPA](https://napa.mawasiliano.go.tz/find-postcode)** (National Postcode and
Addressing system, Ministry of Communication). The site links to it from the
postcode field and says plainly that what we show is unofficial — use NaPA for
anything official. Its API is authenticated (`401` without credentials), so
there is no bulk data to pull; requesting access would be the way to replace our
source outright.

What we show instead comes from **[tanzaniapostcode.com](https://www.tanzaniapostcode.com/)**,
which is not ours and is credited on the page. Their sitemap encodes every record
in the URL itself:

```
/arusha-arumeru-akheri-akheri-23306.html
 region  district ward   location postcode
```

so the whole dataset comes from **one sitemap download — the site is never
crawled**. The postcode is constant across a ward's locations, so it joins at
ward level. `build/postcodes.py` matches their slugs against our own ward names
(theirs omit the `" Ward"`/`" Shehia"` suffix ours carry, and their district
names differ — their `arumeru` is our `meru`, so the match is on region + ward
with the district only breaking ties). **3,053 of 4,344 wards (70.3%) resolve.**
Where a majority of a ward's records disagree, or where two wards in one region
share a name, the ward is dropped rather than guessed.

Keying these to the NBS ward rather than to a `data.json` triple is what let
Songwe get postcodes at all — 85 of its 94 wards now have one, where previously
it could have none, because Songwe does not appear in `data.json`.

It is a third-party aggregator, not Tanzania Posts Corporation, so it was
cross-checked against an independent source: the 913 well-formed `addr:postcode`
tags in OSM that fall inside Tanzania. **9 of 10 regions agreed**, and 29 of 31
regions use a single consistent prefix. The one disagreement is Songwe (site
`54`, OSM `35`) — `35` is Kagera's prefix and Songwe is nowhere near Kagera, so
a bad OSM import is the likelier explanation, but it is unverified.

The page states it is not an official postal source and points to NaPA for
anything legally significant. Note the NBS ward code also shown is a statistical
identifier, **not** postal — the two are labelled distinctly so they cannot be
confused.

## Address format

Copying offers two shapes, because they serve different jobs:

- **Nakili sehemu** — labelled fields (`Mkoa: …`, `Wilaya: …`), for filling a form
  box by box.
- **Nakili anwani** — an address block in the order Tanzanian addresses are
  written, finest first with the postcode beside the district:

```
[Namba ya nyumba na barabara]
Tengeru
Akheri
23306 Meru
ARUSHA
TANZANIA
```

NaPA composes an address from house number + road + mtaa + ward + postcode +
district + region. We know everything from the mtaa outwards, so the first line
is left as a visible prompt rather than silently dropped — the resident is the
only one who knows it. Adding road names (from OSM) is the obvious next step and
would complete the format.

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

Regions, councils, wards and all boundaries: **Tanzania National Bureau of
Statistics, 2022 Population and Housing Census** —
[ward shapefile](https://www.nbs.go.tz/statistics/topic/gis). NBS asks to be
cited. Note their [microdata catalogue entry](https://microdata.nbs.go.tz/index.php/catalog/49)
mentions a confidentiality declaration for census microdata; this ward file is
offered as a public download on their GIS page, and levels below ward (villages,
enumeration areas) require a written request.

Village points: OpenStreetMap, **ODbL 1.0**. Map tiles: OpenStreetMap.

`web/data/` is a derivative of all of the above, so redistributing it carries
both licences and their attribution requirements. Both are credited in the site
footer, not only here.
