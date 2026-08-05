"""Build the per-region data files the web app loads.

Ward geometry is hybrid. The 2018 NBS/OCHA boundaries are preferred: they are
authoritative, carry official P-codes, and know about Songwe (created 2016,
absent from data.json). Where a data.json ward has no 2018 polygon, the 2015
OpenStreetMap polygon fills in, which keeps coverage high -- data.json is itself
a 2015-era list, so it matches the older source slightly better.

Emits:
  web/data/index.json          regions + bboxes (loaded first)
  web/data/regions.json        simplified 2018 ADM1 outlines for region lookup
  web/data/wards/<slug>.json   every ward of one region: district, ward,
                               villages, village coordinates, geometry

Coordinates are rounded to 5 decimal places (~1 m), far finer than either the
polygon simplification or phone GPS.
"""
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

from link import region_key

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "data"
PRECISION = 5


def slugify(s):
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s)).strip("-")


def round_coords(c):
    if isinstance(c[0], (int, float)):
        return [round(c[0], PRECISION), round(c[1], PRECISION)]
    return [round_coords(x) for x in c]


def geom_bbox(g, box=None):
    box = box or [180.0, 90.0, -180.0, -90.0]

    def walk(c):
        if isinstance(c[0], (int, float)):
            box[0] = min(box[0], c[0]); box[1] = min(box[1], c[1])
            box[2] = max(box[2], c[0]); box[3] = max(box[3], c[1])
        else:
            for x in c:
                walk(x)

    walk(g["coordinates"])
    return box


def parts(g):
    """Polygon/MultiPolygon -> list of polygons (each a list of rings)."""
    if g["type"] == "Polygon":
        return [g["coordinates"]]
    if g["type"] == "MultiPolygon":
        return list(g["coordinates"])
    return []


def as_geom(polys):
    g = ({"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1
         else {"type": "MultiPolygon", "coordinates": polys})
    g["coordinates"] = round_coords(g["coordinates"])
    return g


def main():
    rows = json.loads((ROOT / "data.json").read_text())
    linked15 = json.loads((ROOT / "build" / "linked.json").read_text())
    linked18 = json.loads((ROOT / "build" / "linked_2018.json").read_text())
    simp15 = json.loads((ROOT / "build" / "adm3_simp.geojson").read_text())["features"]
    simp18 = json.loads((ROOT / "build" / "adm3_2018_simp.geojson").read_text())["features"]
    adm1 = json.loads((ROOT / "build" / "adm1_2018_simp.geojson").read_text())["features"]
    pts_path = ROOT / "build" / "village_points.json"
    vpoints = json.loads(pts_path.read_text()) if pts_path.exists() else {}

    # --- geometry, per source, keyed by (Region, District, Ward) ------------
    g15 = defaultdict(list)
    by_shape = {f["properties"]["shapeID"]: f["geometry"] for f in simp15}
    for rec in linked15:
        g = by_shape.get(rec["shapeID"])
        if g:
            g15[(rec["region"], rec["district"], rec["ward"])].extend(parts(g))

    g18 = defaultdict(list)
    by_pcode = {f["properties"]["ADM3_PCODE"]: f["geometry"] for f in simp18}
    for rec in linked18:
        g = by_pcode.get(rec["pcode"])
        if g:
            g18[(rec["region"], rec["district"], rec["ward"])].extend(parts(g))
    pcode_of = {(r["region"], r["district"], r["ward"]): r["pcode"] for r in linked18}

    # --- hierarchy: data.json, plus wards from regions it does not know -----
    hier = defaultdict(lambda: defaultdict(list))
    seen, dropped = set(), []
    for r in rows:
        k = (r["Region"], r["District"], r["Ward_Shehia"], r["Village_Mtaa"])
        if not all(str(x).strip() for x in k):
            dropped.append(r)
            continue
        if k in seen:
            continue
        seen.add(k)
        hier[r["Region"]][(r["District"], r["Ward_Shehia"])].append(r["Village_Mtaa"])
    if dropped:
        print(f"  dropped {len(dropped)} row(s) with a blank level")

    extra = 0
    for rec in linked18:
        if rec["how"] != "new-region":
            continue
        key = (rec["district"], rec["ward"])
        if key not in hier[rec["region"]]:
            hier[rec["region"]][key] = []
            extra += 1
    if extra:
        regions = sorted({r["region"] for r in linked18 if r["how"] == "new-region"})
        print(f"  added {extra} ward(s) from region(s) absent from data.json: {', '.join(regions)}")

    # --- write per-region files --------------------------------------------
    (OUT / "wards").mkdir(parents=True, exist_ok=True)
    index = []
    total = with_geom = located = from18 = from15 = 0

    for region, wards in sorted(hier.items()):
        slug = slugify(region)
        out, rbox = [], None
        for (district, ward), villages in sorted(wards.items()):
            names = sorted(set(villages))
            entry = {"d": district, "w": ward, "v": names}
            total += 1

            coords = [vpoints.get(f"{region}|{district}|{ward}|{n}") for n in names]
            if any(coords):
                entry["c"] = coords
                located += sum(1 for c in coords if c)

            key = (region, district, ward)
            polys, src = g18.get(key), "2018"
            if not polys:
                polys, src = g15.get(key), "2015"
            if polys:
                with_geom += 1
                from18 += src == "2018"
                from15 += src == "2015"
                entry["g"] = as_geom(polys)
                entry["b"] = [round(v, PRECISION) for v in geom_bbox(entry["g"])]
                entry["s"] = src
                if src == "2018" and key in pcode_of:
                    entry["p"] = pcode_of[key]
                rbox = geom_bbox(entry["g"], rbox)
            out.append(entry)

        path = OUT / "wards" / f"{slug}.json"
        path.write_text(json.dumps({"region": region, "wards": out}, separators=(",", ":")))
        index.append({
            "region": region, "slug": slug,
            "wards": len(out),
            "mapped": sum(1 for e in out if "g" in e),
            # Per-region data-quality signals, disclosed in the page footer.
            "old": sum(1 for e in out if e.get("s") == "2015"),   # 2015 fallback
            "nogeo": sum(1 for e in out if "g" not in e),          # no polygon
            "novill": sum(1 for e in out if not e["v"]),           # no village list
            "villages": sum(len(e["v"]) for e in out),
            "located": sum(sum(1 for c in e.get("c", []) if c) for e in out),
            "bbox": [round(v, PRECISION) for v in rbox] if rbox else None,
            "kb": round(path.stat().st_size / 1024),
        })

    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")))

    # --- region outlines (2018, so Songwe resolves as its own region) -------
    display = {region_key(e["region"]): (e["region"], e["slug"]) for e in index}
    feats, unresolved = [], []
    for f in adm1:
        gb = f["properties"]["ADM1_EN"]
        hit = display.get(region_key(gb))
        if not hit:
            unresolved.append(gb)
            continue
        feats.append({
            "type": "Feature",
            "properties": {"name": hit[0], "slug": hit[1]},
            "geometry": {"type": f["geometry"]["type"],
                         "coordinates": round_coords(f["geometry"]["coordinates"])},
        })
    if unresolved:
        print(f"  WARNING: ADM1 regions not resolved: {unresolved}")
    (OUT / "regions.json").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))

    nv = sum(e["villages"] for e in index)
    print(f"\nregions : {len(index)}  (region outlines: {len(feats)})")
    print(f"wards   : {total}   with polygon: {with_geom} ({100*with_geom/total:.1f}%)")
    print(f"          from 2018 NBS: {from18}   from 2015 OSM: {from15}")
    print(f"villages: {nv}   with coordinates: {located} ({100*located/nv:.1f}%)")
    tot = sum(e["kb"] for e in index)
    sizes = sorted((e["kb"] for e in index), reverse=True)
    print(f"payload : total {tot} KB, median region {sizes[len(sizes)//2]} KB, max {sizes[0]} KB")


if __name__ == "__main__":
    main()
