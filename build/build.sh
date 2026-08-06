#!/usr/bin/env bash
# Regenerate web/data/ from data.json + geoBoundaries. Run from the repo root:
#   bash build/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."

RAW=build/raw
mkdir -p "$RAW"

echo "==> downloading geoBoundaries (skipping any already present)"
for L in ADM1 ADM2 ADM3; do
  OUT="$RAW/tza_$(echo "$L" | tr 'A-Z' 'a-z').geojson"
  [ "$L" != ADM3 ] && OUT="$RAW/tza_$L.geojson"
  if [ -s "$OUT" ]; then echo "    have $OUT"; continue; fi
  URL=$(curl -sS "https://www.geoboundaries.org/api/current/gbOpen/TZA/$L/" \
        | python3 -c "import sys,json;print(json.load(sys.stdin)['gjDownloadURL'])")
  echo "    fetching $L"
  curl -sSL "$URL" -o "$OUT"
done

if [ ! -x build/venv/bin/python ]; then
  echo "==> creating venv"
  python3 -m venv build/venv
  build/venv/bin/pip install --quiet shapely rapidfuzz pyshp
fi

echo "==> linking ward polygons to data.json names"
build/venv/bin/python build/link.py

echo "==> fetching OSM place data (for village coordinates)"
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
BBOX="-11.9,29.2,-0.8,40.7"
cat > /tmp/q_places.txt <<EOF
[out:json][timeout:600];
node["place"~"^(city|town|village|hamlet|suburb|neighbourhood|quarter|locality|isolated_dwelling)\$"]["name"]($BBOX);
out body;
EOF
cat > /tmp/q_areas.txt <<EOF
[out:json][timeout:600];
(way["place"]["name"]($BBOX);relation["place"]["name"]($BBOX););
out center;
EOF
cat > /tmp/q_admin.txt <<EOF
[out:json][timeout:600];
(way["boundary"="administrative"]["name"]["admin_level"~"^(9|10|11)\$"]($BBOX);
 relation["boundary"="administrative"]["name"]["admin_level"~"^(9|10|11)\$"]($BBOX););
out center;
EOF
fetch_overpass "$RAW/osm_places.json" /tmp/q_places.txt
fetch_overpass "$RAW/osm_areas.json"  /tmp/q_areas.txt
fetch_overpass "$RAW/osm_admin.json"  /tmp/q_admin.txt

echo "==> fetching 2018 NBS/OCHA boundaries (primary source)"
for L in adm1 adm3; do
  Z="$RAW/tza_${L}_2018.zip"
  if [ ! -s "$Z" ]; then
    U=$(curl -sSL --max-time 120 "https://data.humdata.org/api/3/action/package_show?id=cod-ab-tza" \
        | python3 -c "import sys,json;print(next(r['url'] for r in json.load(sys.stdin)['result']['resources'] if r['name']=='tza_admbnda_${L}_20181019.zip'))")
    curl -sSL --max-time 600 "$U" -o "$Z"
  fi
  unzip -oq "$Z" -d "$RAW/${L}_2018"
done

echo "==> simplifying polygons"
npx -y mapshaper "$RAW/tza_adm3.geojson" -simplify 6% keep-shapes -o build/adm3_simp.geojson force
npx -y mapshaper "$RAW/tza_ADM1.geojson" -simplify 4% keep-shapes -o build/adm1_simp.geojson force
npx -y mapshaper "$RAW/adm3_2018/tza_admbnda_adm3_20181019.shp" -simplify 6% keep-shapes -o build/adm3_2018_simp.geojson force
npx -y mapshaper "$RAW/adm1_2018/tza_admbnda_adm1_20181019.shp" -simplify 4% keep-shapes -o build/adm1_2018_simp.geojson force

echo "==> linking 2018 ward polygons to data.json"
(cd build && ../build/venv/bin/python link2018.py)

echo "==> locating villages from OSM"
(cd build && ../build/venv/bin/python villages.py)

echo "==> fetching postcode sitemap (tanzaniapostcode.com)"
mkdir -p "$RAW/tpc"
for f in root.xml listing_part1.xml.gz listing_part2.xml.gz; do
  [ -s "$RAW/tpc/$f" ] || curl -sSL --max-time 180 "https://www.tanzaniapostcode.com/xml/$f" -o "$RAW/tpc/$f"
done

echo "==> joining postcodes to wards"
(cd build && ../build/venv/bin/python postcodes.py)

echo "==> writing web/data"
(cd build && ../build/venv/bin/python web_data.py)

echo "==> tests"
node build/test_data.js
node build/test_geo.js

echo "==> done. serve with:  cd web && python3 -m http.server 8777"
