"""Build web/data/ from the NBS 2022 census wards, the authoritative source.

Hierarchy and geometry come from the National Bureau of Statistics 2022 Population
and Housing Census ward shapefile: 31 regions, 195 councils, 4,344 wards, each
with official codes. This is what replaced the old pipeline's guesswork -- the
2015/2018 sources predated the councils created in 2015-16, so Kimara reported
Kinondoni when it has been Ubungo for a decade.

data.json contributes only what NBS does not carry: village/mtaa lists and the
postcodes joined from tanzaniapostcode.com. Those are attached where the ward
matches by name and simply left absent where it does not. A ward's district is
never taken from data.json, so a stale council name cannot come back.

Emits:
  web/data/index.json          regions + bboxes + per-region quality counts
  web/data/regions.json        region outlines, dissolved from the same wards
  web/data/wards/<slug>.json   every ward of one region

Entry keys are terse because every byte ships: d district, cn council,
w ward, v villages, c village coordinates, pc postcode, g geometry,
b bbox, code official ward code.
"""
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

from names import district_key, region_key, ward_key

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "data"
PRECISION = 5

# Councils are named "Halmashauri ya Manispaa ya Ubungo", "Halmashauri ya Jiji
# la Dodoma", "Baraza la Manispaa Mjini". The short dist_name is what forms ask
# for; the full name is shown beneath it as proof of which council it is.


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


def source_villages(rows):
    """data.json indexed by (region_key, ward_key) -> {(Region, District, Ward): {villages}}.

    The original triple is kept because build/village_points.json and
    build/ward_postcodes.json are keyed on data.json's exact spelling.
    """
    out = defaultdict(lambda: defaultdict(set))
    for r in rows:
        reg, dist, ward, vil = (str(r.get(k, "")).strip() for k in
                                ("Region", "District", "Ward_Shehia", "Village_Mtaa"))
        if not (reg and ward and vil):
            continue
        out[(region_key(reg), ward_key(ward))][(reg, dist, ward)].add(vil)
    return out


def pick_source(cands, dist_name, counc_name):
    """Choose which data.json ward feeds an NBS ward, or None if unclear.

    A ward name can repeat inside one region, so where several candidates exist
    only a district agreement is accepted -- attaching another council's
    villages would be worse than attaching none.
    """
    if len(cands) == 1:
        return next(iter(cands))
    if not cands:
        return None
    want = {district_key(dist_name), district_key(counc_name)}
    hits = [k for k in cands if district_key(k[1]) in want]
    return hits[0] if len(hits) == 1 else None


def main():
    rows = json.loads((ROOT / "data.json").read_text())
    wards_gj = json.loads((ROOT / "build" / "nbs2022_simp.geojson").read_text())["features"]
    regions_gj = json.loads((ROOT / "build" / "nbs2022_regions.geojson").read_text())["features"]
    vp = ROOT / "build" / "village_points.json"
    vpoints = json.loads(vp.read_text()) if vp.exists() else {}
    pcp = ROOT / "build" / "ward_postcodes.json"
    postcodes = json.loads(pcp.read_text()) if pcp.exists() else {}

    old = source_villages(rows)

    # --- write per-region ward files ----------------------------------------
    by_region = defaultdict(list)
    for f in wards_gj:
        by_region[f["properties"]["reg_name"]].append(f)

    (OUT / "wards").mkdir(parents=True, exist_ok=True)
    for stale in (OUT / "wards").glob("*.json"):
        stale.unlink()

    index = []
    total = matched = ambiguous = located = with_pc = 0
    nvill = 0

    for region, feats in sorted(by_region.items()):
        slug = slugify(region)
        out, rbox = [], None

        for f in sorted(feats, key=lambda f: (f["properties"]["dist_name"],
                                              f["properties"]["ward_name"])):
            p = f["properties"]
            total += 1
            entry = {
                "d": p["dist_name"],
                "cn": p["counc_name"],
                "w": p["ward_name"],
                # ward_code repeats across councils, so the identifier needs the
                # whole chain. Even then NBS ships 5 collisions (see below).
                "code": f"{p['reg_code']}{p['dist_code']}{p['counc_code']}{p['ward_code']}",
                "v": [],
            }

            # Attach villages/postcode from data.json where the ward matches.
            jkey = (region_key(region), ward_key(p["ward_name"]))
            cands = old.get(jkey, {})
            pick = pick_source(cands, p["dist_name"], p["counc_name"])
            if cands and not pick:
                ambiguous += 1

            if pick:
                matched += 1
                names = sorted(cands[pick])
                entry["v"] = names
                coords = [vpoints.get(f"{pick[0]}|{pick[1]}|{pick[2]}|{n}") for n in names]
                if any(coords):
                    entry["c"] = coords
                    located += sum(1 for c in coords if c)
            nvill += len(entry["v"])

            # Postcodes are keyed straight to the NBS ward, so a ward with no
            # village list can still carry one.
            pc = postcodes.get("|".join(jkey))
            if pc:
                entry["pc"] = pc
                with_pc += 1

            g = f["geometry"]
            g = {"type": g["type"], "coordinates": round_coords(g["coordinates"])}
            entry["g"] = g
            entry["b"] = [round(v, PRECISION) for v in geom_bbox(g)]
            rbox = geom_bbox(g, rbox)
            out.append(entry)

        path = OUT / "wards" / f"{slug}.json"
        path.write_text(json.dumps({"region": region, "wards": out}, separators=(",", ":")))
        index.append({
            "region": region, "slug": slug,
            "wards": len(out),
            "councils": len({e["cn"] for e in out}),
            "mapped": len(out),                                    # every ward has geometry
            "novill": sum(1 for e in out if not e["v"]),           # no village list
            "pc": sum(1 for e in out if "pc" in e),                # has a postcode
            "villages": sum(len(e["v"]) for e in out),
            "located": sum(sum(1 for c in e.get("c", []) if c) for e in out),
            "bbox": [round(v, PRECISION) for v in rbox] if rbox else None,
            "kb": round(path.stat().st_size / 1024),
        })

    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")))

    # --- region outlines, dissolved from the very same ward polygons --------
    slugs = {e["region"]: e["slug"] for e in index}
    feats = [{
        "type": "Feature",
        "properties": {"name": f["properties"]["reg_name"],
                       "slug": slugs[f["properties"]["reg_name"]]},
        "geometry": {"type": f["geometry"]["type"],
                     "coordinates": round_coords(f["geometry"]["coordinates"])},
    } for f in regions_gj if f["properties"]["reg_name"] in slugs]
    missing = {f["properties"]["reg_name"] for f in regions_gj} - set(slugs)
    if missing:
        print(f"  WARNING: region outlines with no ward file: {sorted(missing)}")
    (OUT / "regions.json").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))

    # NBS ships a handful of distinct wards sharing one code. Nothing is keyed
    # on the code, so this is reported rather than repaired -- but it is
    # reported, so a change in the source does not pass unnoticed.
    seen_codes = defaultdict(list)
    for e in index:
        for w in json.loads((OUT / "wards" / f"{e['slug']}.json").read_text())["wards"]:
            seen_codes[w["code"]].append(f"{e['region']}/{w['d']}/{w['w']}")
    dupes = {k: v for k, v in seen_codes.items() if len(v) > 1}
    if dupes:
        print(f"\n  NOTE: {len(dupes)} ward code(s) reused by NBS:")
        for k, v in sorted(dupes.items()):
            print(f"    {k}  {' | '.join(v)}")

    councils = sum(e["councils"] for e in index)
    print(f"\nregions : {len(index)}  (outlines: {len(feats)})")
    print(f"councils: {councils}")
    print(f"wards   : {total}   all with geometry")
    print(f"villages: matched {matched}/{total} wards ({100*matched/total:.1f}%)"
          + (f", {ambiguous} ambiguous" if ambiguous else ""))
    print(f"          {nvill} villages, {located} with coordinates"
          + (f" ({100*located/nvill:.1f}%)" if nvill else ""))
    print(f"postcode: {with_pc}/{total} wards ({100*with_pc/total:.1f}%)")
    tot = sum(e["kb"] for e in index)
    sizes = sorted((e["kb"] for e in index), reverse=True)
    print(f"payload : total {tot} KB, median region {sizes[len(sizes)//2]} KB, max {sizes[0]} KB")


if __name__ == "__main__":
    main()
