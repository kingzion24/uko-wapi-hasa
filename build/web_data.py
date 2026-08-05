"""Build the per-region data files the web app loads.

Emits:
  web/data/index.json          regions + bboxes (loaded first, ~5 KB)
  web/data/regions.json        simplified ADM1 outlines for region lookup
  web/data/wards/<slug>.json   every ward of one region: district, ward,
                               villages, and geometry (null when the ward has
                               no polygon in geoBoundaries)

Coordinates are rounded to 5 decimal places (~1 m), which is far finer than
either the polygon simplification or phone GPS.
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


def main():
    rows = json.loads((ROOT / "data.json").read_text())
    linked = json.loads((ROOT / "build" / "linked.json").read_text())
    pts_path = ROOT / "build" / "village_points.json"
    vpoints = json.loads(pts_path.read_text()) if pts_path.exists() else {}
    simp = json.loads((ROOT / "build" / "adm3_simp.geojson").read_text())["features"]
    adm1 = json.loads((ROOT / "build" / "adm1_simp.geojson").read_text())["features"]

    # shapeID -> simplified geometry
    geom_by_id = {f["properties"]["shapeID"]: f["geometry"] for f in simp}
    # (Region, District, Ward) -> [polygon parts]
    geom_by_ward = defaultdict(list)
    for rec in linked:
        g = geom_by_id.get(rec["shapeID"])
        if g:
            geom_by_ward[(rec["region"], rec["district"], rec["ward"])].extend(parts(g))

    # full hierarchy from data.json, so wards without a polygon still appear
    hier = defaultdict(lambda: defaultdict(list))
    seen, dropped = set(), []
    for r in rows:
        k = (r["Region"], r["District"], r["Ward_Shehia"], r["Village_Mtaa"])
        # A blank level would render as an empty dropdown entry and put an empty
        # field on someone's form, so drop those rows.
        if not all(str(x).strip() for x in k):
            dropped.append(r)
            continue
        if k in seen:
            continue
        seen.add(k)
        hier[r["Region"]][(r["District"], r["Ward_Shehia"])].append(r["Village_Mtaa"])

    if dropped:
        print(f"  dropped {len(dropped)} row(s) with a blank level: {dropped}")

    (OUT / "wards").mkdir(parents=True, exist_ok=True)
    index, with_geom, total, located = [], 0, 0, 0

    for region, wards in sorted(hier.items()):
        slug = slugify(region)
        out, rbox = [], None
        for (district, ward), villages in sorted(wards.items()):
            polys = geom_by_ward.get((region, district, ward))
            names = sorted(set(villages))
            entry = {"d": district, "w": ward, "v": names}
            total += 1

            # Parallel array of village coordinates (null where unknown), so the
            # app can name the nearest one instead of only offering a list.
            coords = [vpoints.get(f"{region}|{district}|{ward}|{n}") for n in names]
            if any(coords):
                entry["c"] = coords
                located += sum(1 for c in coords if c)
            if polys:
                with_geom += 1
                g = ({"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1
                     else {"type": "MultiPolygon", "coordinates": polys})
                g["coordinates"] = round_coords(g["coordinates"])
                entry["g"] = g
                entry["b"] = [round(v, PRECISION) for v in geom_bbox(g)]
                rbox = geom_bbox(g, rbox)
            out.append(entry)

        path = OUT / "wards" / f"{slug}.json"
        path.write_text(json.dumps({"region": region, "wards": out},
                                   separators=(",", ":")))
        index.append({
            "region": region, "slug": slug,
            "wards": len(out),
            "mapped": sum(1 for e in out if "g" in e),
            "villages": sum(len(e["v"]) for e in out),
            "located": sum(sum(1 for c in e.get("c", []) if c) for e in out),
            "bbox": [round(v, PRECISION) for v in rbox] if rbox else None,
            "kb": round(path.stat().st_size / 1024),
        })

    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")))

    # ADM1 outlines, carrying the data.json region name/slug so the app can go
    # straight from a region hit to the right ward file.
    slug_by_gb = {region_key(e["region"]): (e["region"], e["slug"]) for e in index}
    feats, unresolved = [], []
    for f in adm1:
        gb = f["properties"]["shapeName"]
        hit = slug_by_gb.get(region_key(gb))
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
        print(f"  WARNING: ADM1 regions not resolved to data.json: {unresolved}")
    (OUT / "regions.json").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))

    nv = sum(e["villages"] for e in index)
    print(f"regions: {len(index)}   wards: {total}   with polygon: {with_geom} "
          f"({100*with_geom/total:.1f}%)")
    print(f"villages: {nv}   with coordinates: {located} ({100*located/nv:.1f}%)")
    print(f"largest region files:")
    for e in sorted(index, key=lambda e: -e["kb"])[:6]:
        print(f"  {e['region']:22} {e['kb']:5} KB  {e['mapped']}/{e['wards']} mapped")
    tot = sum(e["kb"] for e in index)
    print(f"total ward data {tot} KB, index {round((OUT/'index.json').stat().st_size/1024)} KB, "
          f"regions.json {round((OUT/'regions.json').stat().st_size/1024)} KB")


if __name__ == "__main__":
    main()
