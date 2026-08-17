"""Give each village/mtaa a coordinate, so the app can name the most likely one
instead of only offering a dropdown.

OSM place nodes are assigned to the ward polygon that contains them, then
matched by name against that ward's village list from data.json. Matching
inside a ward keeps it safe: a name only has to be unique among the handful of
villages in one ward, not nationally.

Assignment uses the NBS 2022 ward polygons -- the same ones the app ships. Using
different polygons than the ones we serve would put a village in a ward the site
never shows it in.

Outputs build/village_points.json: "Region|District|Ward|Village" -> [lon, lat]
keyed on data.json's spelling, because that is what web_data reads back.
"""
import json
from collections import defaultdict
from pathlib import Path

from rapidfuzz import fuzz, process
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

from names import norm, region_key, ward_key
from nbs2022 import pick_source, source_villages

ROOT = Path(__file__).resolve().parent.parent
NAME_SCORE_MIN = 90


def main():
    rows = json.loads((ROOT / "data.json").read_text())
    wards_gj = json.loads((ROOT / "build" / "nbs2022_simp.geojson").read_text())["features"]
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

    # Villages of each ward, from data.json, indexed the way the 2022 wards
    # join to it.
    source = source_villages(rows)
    villages = defaultdict(list)
    for cands in source.values():
        for triple, vs in cands.items():
            villages[triple].extend(vs)

    # Each 2022 ward polygon, tagged with the data.json ward it corresponds to.
    geoms, keys = [], []
    for f in wards_gj:
        p = f["properties"]
        cands = source.get((region_key(p["reg_name"]), ward_key(p["ward_name"])), {})
        triple = pick_source(cands, p["dist_name"], p["counc_name"])
        if not triple:
            continue
        geoms.append(shape(f["geometry"]))
        keys.append(triple)
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
