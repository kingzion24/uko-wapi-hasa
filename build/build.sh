#!/usr/bin/env bash
# Regenerate web/data/ from the NBS 2022 census wards. Run from the repo root:
#   bash build/build.sh
#
# Downloads are cached in build/raw, so a second run is fast. web/data/ is
# committed, so CI never runs this -- it only verifies what is committed.
set -euo pipefail
cd "$(dirname "$0")/.."

RAW=build/raw
mkdir -p "$RAW"

if [ ! -x build/venv/bin/python ]; then
  echo "==> creating venv"
  python3 -m venv build/venv
  build/venv/bin/pip install --quiet shapely rapidfuzz pyshp pyproj
fi
PY=build/venv/bin/python

# --- the authoritative source -----------------------------------------------
# The 2022 Population and Housing Census ward shapefile, published by the
# National Bureau of Statistics. Levels 1-3 (region / district / ward) are
# public; anything finer needs a written request to NBS. This is the only
# source that knows about the councils created in 2015-16, which is why the
# site can now say Ubungo instead of Kinondoni.
NBS_URL="https://www.nbs.go.tz/uploads/statistics/documents/en-1714652282-TANZANIA_2022PHC_WARD_SHAPEFILES.zip"
if [ ! -s "$RAW/tza_wards_2022.zip" ]; then
  echo "==> downloading NBS 2022 census ward shapefile"
  curl -sSL --max-time 600 "$NBS_URL" -o "$RAW/tza_wards_2022.zip"
fi
[ -d "$RAW/nbs2022" ] || unzip -oq "$RAW/tza_wards_2022.zip" -d "$RAW/nbs2022"

echo "==> reprojecting to WGS84"
# EPSG:3395, not 3857 -- see build/nbs_geojson.py. The script refuses to write
# if the result lands outside Tanzania.
$PY build/nbs_geojson.py

echo "==> simplifying polygons"
# mapshaper rather than shapely: its simplification is topology-aware, so
# neighbouring wards keep a shared edge instead of opening slivers that no
# point-in-polygon test would match.
npx -y mapshaper build/nbs2022_wards.geojson -simplify 6% keep-shapes \
  -o build/nbs2022_simp.geojson force
npx -y mapshaper build/nbs2022_wards.geojson -dissolve reg_name -simplify 4% keep-shapes \
  -o build/nbs2022_regions.geojson force

# --- village coordinates, from OSM ------------------------------------------
# NBS does not publish village/mtaa points, so these come from OpenStreetMap and
# are matched by name inside each ward.
fetch_overpass() {  # $1 = output file, $2 = query file
  [ -s "$1" ] && { echo "    have $1"; return; }
  for EP in https://overpass-api.de/api/interpreter https://overpass.kumi.systems/api/interpreter; do
    curl -sS --max-time 900 -X POST -d @"$2" "$EP" -o "$1" || true
    head -c 5 "$1" 2>/dev/null | grep -q '{' && { echo "    got $1"; return; }
    echo "    $EP busy, retrying elsewhere"
  done
  echo "    WARNING: could not fetch $1 — village coordinates will be skipped"
  rm -f "$1"
}
echo "==> fetching OSM place data"
BBOX="-11.9,29.2,-0.8,40.7"
Q=$(mktemp -d)
cat > "$Q/places.txt" <<EOF
[out:json][timeout:600];
node["place"~"^(city|town|village|hamlet|suburb|neighbourhood|quarter|locality|isolated_dwelling)\$"]["name"]($BBOX);
out body;
EOF
cat > "$Q/areas.txt" <<EOF
[out:json][timeout:600];
(way["place"]["name"]($BBOX);relation["place"]["name"]($BBOX););
out center;
EOF
cat > "$Q/admin.txt" <<EOF
[out:json][timeout:600];
(way["boundary"="administrative"]["name"]["admin_level"~"^(9|10|11)\$"]($BBOX);
 relation["boundary"="administrative"]["name"]["admin_level"~"^(9|10|11)\$"]($BBOX););
out center;
EOF
fetch_overpass "$RAW/osm_places.json" "$Q/places.txt"
fetch_overpass "$RAW/osm_areas.json"  "$Q/areas.txt"
fetch_overpass "$RAW/osm_admin.json"  "$Q/admin.txt"
rm -rf "$Q"

# --- postcodes ---------------------------------------------------------------
echo "==> fetching postcode sitemap (tanzaniapostcode.com)"
mkdir -p "$RAW/tpc"
for f in root.xml listing_part1.xml.gz listing_part2.xml.gz; do
  [ -s "$RAW/tpc/$f" ] || curl -sSL --max-time 180 "https://www.tanzaniapostcode.com/xml/$f" -o "$RAW/tpc/$f"
done

echo "==> joining postcodes to wards"
(cd build && ../$PY postcodes.py)

echo "==> locating villages"
(cd build && ../$PY villages.py)

echo "==> writing web/data"
(cd build && ../$PY nbs2022.py)

echo "==> tests"
node build/test_data.js
node build/test_geo.js
node build/test_markup.js

echo "==> done. serve with:  cd web && python3 -m http.server 8777"
