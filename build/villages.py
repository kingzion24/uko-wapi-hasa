"""Give each village/mtaa a coordinate, so the app can name the most likely one
instead of only offering a dropdown.

OSM place nodes are assigned to the ward polygon that contains them, then
matched by name against that ward's village list from data.json. Matching
inside a ward keeps it safe: a name only has to be unique among the handful of
villages in one ward, not nationally.

Outputs build/village_points.json: "Region|District|Ward|Village" -> [lon, lat]
"""
import json
from collections import defaultdict
from pathlib import Path

from rapidfuzz import fuzz, process
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

from link import norm

ROOT = Path(__file__).resolve().parent.parent
NAME_SCORE_MIN = 90


def main():
    rows = json.loads((ROOT / "data.json").read_text())
    linked = json.loads((ROOT / "build" / "linked.json").read_text())
    adm3 = json.loads((ROOT / "build" / "adm3_simp.geojson").read_text())["features"]
    # Rural villages are mapped as place=* nodes; urban mitaa are more often
    # areas (place=subward/neighbourhood) or low-level admin boundaries, so all
    # three sources are merged and reduced to a single representative point.
    places = []
    for src in ("osm_places.json", "osm_areas.json", "osm_admin.json"):
        p = ROOT / "build" / "raw" / src
        if not p.exists():
            print(f"  note: {src} missing, skipping")
            continue
        els = json.loads(p.read_text())["elements"]
        for e in els:
            c = e.get("center") or ({"lat": e.get("lat"), "lon": e.get("lon")})
            if c.get("lat") is None or c.get("lon") is None:
                continue
            places.append({"lat": c["lat"], "lon": c["lon"], "tags": e.get("tags", {})})
        print(f"  {src}: {len(els)} elements")

    # villages of each ward, from data.json
    villages = defaultdict(list)
    for r in rows:
        if all(str(r[k]).strip() for k in r):
            villages[(r["Region"], r["District"], r["Ward_Shehia"])].append(r["Village_Mtaa"])

    # ward polygons, keyed to their data.json identity
    geom_by_id = {f["properties"]["shapeID"]: f["geometry"] for f in adm3}
    geoms, keys = [], []
    for rec in linked:
        g = geom_by_id.get(rec["shapeID"])
        if not g:
            continue
        key = (rec["region"], rec["district"], rec["ward"])
        if key not in villages:
            continue
        geoms.append(shape(g))
        keys.append(key)
    tree = STRtree(geoms)
    print(f"ward polygons: {len(geoms)}   OSM place nodes: {len(places)}")

    # candidate name list per ward, normalised
    cand = {k: {norm(v): v for v in set(vs)} for k, vs in villages.items()}

    # place node -> (ward, village)
    hits = {}
    scores = defaultdict(int)
    inside = 0
    for p in places:
        name = p.get("tags", {}).get("name")
        if not name:
            continue
        pt = Point(p["lon"], p["lat"])
        ward = None
        for i in tree.query(pt):
            if geoms[i].contains(pt):
                ward = keys[i]
                break
        if not ward:
            continue
        inside += 1
        pool = cand.get(ward)
        if not pool:
            continue
        n = norm(name)
        if n in pool:
            village, score = pool[n], 100
        else:
            hit = process.extractOne(n, list(pool), scorer=fuzz.WRatio)
            if not hit or hit[1] < NAME_SCORE_MIN:
                continue
            village, score = pool[hit[0]], hit[1]

        key = "|".join(ward + (village,))
        # Prefer the better-scoring node when several match one village.
        if key not in hits or score > hits[key][1]:
            hits[key] = ([round(p["lon"], 5), round(p["lat"], 5)], score)
            scores[100 if score == 100 else 90] += 1

    out = {k: v[0] for k, v in hits.items()}
    total = sum(len(set(v)) for v in villages.values())
    print(f"place nodes inside a ward: {inside}")
    print(f"villages located: {len(out)}/{total} ({100*len(out)/total:.1f}%)"
          f"  exact-name {scores[100]}, fuzzy {scores[90]}")

    per_ward = defaultdict(int)
    for k in out:
        per_ward["|".join(k.split("|")[:3])] += 1
    wards_with = sum(1 for k in villages if "|".join(k) in per_ward)
    print(f"wards with at least one located village: {wards_with}/{len(villages)}")

    (ROOT / "build" / "village_points.json").write_text(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
