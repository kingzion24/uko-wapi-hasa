"""Convert the NBS 2022 census ward shapefile to WGS84 GeoJSON.

The shapefile's .prj says WGS_1984_World_Mercator. That is EPSG:3395, the
*ellipsoidal* Mercator -- not the EPSG:3857 spherical "Web Mercator" that most
tooling assumes. Reprojecting with the spherical formula leaves longitude exact
and pushes latitude about 5 km north, which is silent and lands points in the
neighbouring ward. Hence pyproj and an explicit EPSG:3395.

Writes build/nbs2022_wards.geojson at full resolution; build.sh then runs it
through mapshaper, whose simplification is topology-aware and so does not open
slivers between neighbouring wards.
"""
import json
from pathlib import Path

import shapefile
from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "build" / "raw" / "nbs2022" / "TANZANIA_2022PHC_WARDS_SHAPEFILES"
OUT = ROOT / "build" / "nbs2022_wards.geojson"

# Sanity bounds: mainland + islands, with a little slack.
TZ_BOUNDS = (28.9, -12.1, 41.0, -0.8)

FIELDS = ("reg_code", "reg_name", "dist_code", "dist_name",
          "counc_code", "counc_name", "ward_code", "ward_name")


def rings_of(shp):
    """Shapefile parts -> list of rings. Shapefile rings are closed already."""
    idx = list(shp.parts) + [len(shp.points)]
    return [shp.points[a:b] for a, b in zip(idx, idx[1:]) if b - a >= 4]


def signed_area(ring):
    s = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i - 1]
        x2, y2 = ring[i]
        s += x1 * y2 - x2 * y1
    return s / 2


def to_polygons(rings):
    """Group rings into polygons. In shapefiles an outer ring is clockwise
    (negative signed area in a y-up frame) and its holes run the other way, so
    each clockwise ring opens a new polygon and the rest are its holes."""
    polys = []
    for ring in rings:
        if signed_area(ring) < 0 or not polys:
            polys.append([ring])
        else:
            polys[-1].append(ring)
    return polys


def main():
    reader = shapefile.Reader(str(SRC))
    names = [f[0] for f in reader.fields[1:]]
    tx = Transformer.from_crs("EPSG:3395", "EPSG:4326", always_xy=True)

    feats, skipped = [], 0
    for shp, rec in zip(reader.shapes(), reader.records()):
        attrs = dict(zip(names, rec))
        polys = to_polygons(rings_of(shp))
        if not polys:
            skipped += 1
            continue

        out = []
        for poly in polys:
            conv = []
            for ring in poly:
                xs, ys = zip(*ring)
                lons, lats = tx.transform(xs, ys)
                conv.append([[round(a, 6), round(b, 6)] for a, b in zip(lons, lats)])
            out.append(conv)

        geom = ({"type": "Polygon", "coordinates": out[0]} if len(out) == 1
                else {"type": "MultiPolygon", "coordinates": out})
        props = {k: (attrs.get(k) or "").strip() if isinstance(attrs.get(k), str)
                 else attrs.get(k) for k in FIELDS}
        feats.append({"type": "Feature", "properties": props, "geometry": geom})

    # Guard against a wrong CRS silently shifting everything.
    lo = [180.0, 90.0, -180.0, -90.0]
    for f in feats:
        def walk(c):
            if isinstance(c[0], (int, float)):
                lo[0] = min(lo[0], c[0]); lo[1] = min(lo[1], c[1])
                lo[2] = max(lo[2], c[0]); lo[3] = max(lo[3], c[1])
            else:
                for x in c:
                    walk(x)
        walk(f["geometry"]["coordinates"])
    print(f"  bbox: {[round(v, 4) for v in lo]}")
    if not (TZ_BOUNDS[0] <= lo[0] and lo[2] <= TZ_BOUNDS[2]
            and TZ_BOUNDS[1] <= lo[1] and lo[3] <= TZ_BOUNDS[3]):
        raise SystemExit(f"  ERROR: reprojected bbox outside Tanzania {TZ_BOUNDS} "
                         "-- check the source CRS")

    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                              separators=(",", ":")))
    print(f"  wards: {len(feats)}" + (f"  (skipped {skipped} with no geometry)" if skipped else ""))
    print(f"  regions: {len({f['properties']['reg_name'] for f in feats})}"
          f"  councils: {len({(f['properties']['reg_name'], f['properties']['counc_name']) for f in feats})}")
    print(f"  wrote {OUT.name} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
