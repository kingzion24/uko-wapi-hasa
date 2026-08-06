"""Link geoBoundaries ADM3 (ward) polygons to the names in data.json.

ADM3 features carry only a ward name, and ward names are not unique nationally,
so each ward's parent district/region is derived spatially first, then the ward
name is matched against data.json within that parent.

Region assignment from a single representative point is not always right - the
ADM1/ADM2 layers disagree slightly around Dar es Salaam and Arusha - so a ward
that fails to match in its assigned region falls back to a national name search
and is accepted when the name resolves unambiguously.

Outputs build/linked.json and build/unmatched.json.
"""
import json
import unicodedata
from collections import defaultdict
from pathlib import Path

from rapidfuzz import fuzz, process
from shapely.geometry import shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "build" / "raw"

WARD_SCORE_MIN = 88

# Three sources name the regions differently: data.json ("Dar es Salaam
# Region", Swahili Zanzibar names), geoBoundaries gbOpen (English Zanzibar
# names) and the 2018 NBS/OCHA shapefile ("Dar-es-salaam", Swahili Zanzibar
# names). Fold all of them onto one canonical key.
REGION_ALIASES = {
    # data.json suffixes
    "dar es salaam region": "dar es salaam",
    "mtwara region": "mtwara",
    "pwani region": "pwani",
    "coast": "pwani",
    # geoBoundaries English names for Zanzibar -> Swahili canonical
    "north pemba": "kaskazini pemba",
    "pemba north": "kaskazini pemba",
    "south pemba": "kusini pemba",
    "pemba south": "kusini pemba",
    "zanzibar north": "kaskazini unguja",
    "zanzibar south central": "kusini unguja",
    "zanzibar central south": "kusini unguja",
    "zanzibar urban west": "mjini magharibi",
    "zanzibar west": "mjini magharibi",
    # tanzaniapostcode.com naming
    "unguja north": "kaskazini unguja",
    "unguja south": "kusini unguja",
}

# Suffixes that appear in data.json but not in geoBoundaries ward names.
WARD_SUFFIXES = (" ward", " shehia")

# Swahili/English district-type equivalents, for tie-breaking duplicate ward
# names within one region.
DISTRICT_TOKENS = {
    "urban": "mjini", "rural": "vijijini", "town": "mji",
    "municipal": "manispaa", "council": "", "district": "", "dc": "", "tc": "",
}


def strip_accents(s):
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c))


def norm(s):
    """Casefold, strip accents and punctuation, collapse whitespace."""
    s = strip_accents(s).lower().strip()
    s = "".join(c if c.isalnum() else " " for c in s)
    return " ".join(s.split())


def ward_key(s):
    """Ward name normalisation, minus the trailing Ward/Shehia designator."""
    n = norm(s)
    for suf in WARD_SUFFIXES:
        if n.endswith(suf):
            n = n[: -len(suf)].strip()
            break
    return n


def district_key(s):
    toks = [DISTRICT_TOKENS.get(t, t) for t in norm(s).split()]
    return " ".join(t for t in toks if t)


def region_key(s):
    n = norm(s)
    return REGION_ALIASES.get(n, n)


def load(path):
    with open(path) as fh:
        return json.load(fh)["features"]


def main():
    adm1 = load(RAW / "tza_ADM1.geojson")
    adm2 = load(RAW / "tza_ADM2.geojson")
    adm3 = load(RAW / "tza_adm3.geojson")
    rows = json.loads((ROOT / "data.json").read_text())

    # --- reference hierarchy from data.json -------------------------------
    # key: (region_key, district_key, ward_key)
    meta, villages = {}, defaultdict(list)
    by_region = defaultdict(list)   # region_key -> [key]
    by_ward = defaultdict(list)     # ward_key   -> [key]
    for r in rows:
        k = (region_key(r["Region"]), district_key(r["District"]), ward_key(r["Ward_Shehia"]))
        if k not in meta:
            meta[k] = (r["Region"], r["District"], r["Ward_Shehia"])
            by_region[k[0]].append(k)
            by_ward[k[2]].append(k)
        villages[k].append(r["Village_Mtaa"])

    print(f"data.json: {len(rows)} rows -> {len(meta)} unique region/district/ward keys")

    gb_regions = {region_key(f["properties"]["shapeName"]) for f in adm1}
    missing = set(by_region) - gb_regions
    print("  regions reconciled" if not missing else f"  UNRECONCILED REGIONS: {sorted(missing)}")

    # --- spatial parent assignment ----------------------------------------
    r1_geoms = [shape(f["geometry"]) for f in adm1]
    r1_names = [f["properties"]["shapeName"] for f in adm1]
    r2_geoms = [shape(f["geometry"]) for f in adm2]
    r2_names = [f["properties"]["shapeName"] for f in adm2]
    t1, t2 = STRtree(r1_geoms), STRtree(r2_geoms)

    def parent(geom, tree, geoms, names):
        """Containing parent by representative point, else max-overlap area."""
        pt = geom.representative_point()
        for i in tree.query(pt):
            if geoms[i].contains(pt):
                return names[i]
        best, best_area = None, 0.0
        for i in tree.query(geom):
            try:
                a = geoms[i].intersection(geom).area
            except Exception:
                continue
            if a > best_area:
                best, best_area = names[i], a
        return best

    def pick(cands, wn, dk):
        """Best (score, key) among candidate keys for ward name wn."""
        if not cands:
            return 0, None
        names = [k[2] for k in cands]
        exact = [k for k in cands if k[2] == wn]
        if exact:
            best = max(exact, key=lambda k: fuzz.WRatio(dk, k[1]))
            return 100, best
        hit = process.extractOne(wn, names, scorer=fuzz.WRatio)
        if not hit or hit[1] < WARD_SCORE_MIN:
            return (hit[1] if hit else 0), None
        tied = [k for k in cands if k[2] == hit[0]]
        best = max(tied, key=lambda k: fuzz.WRatio(dk, k[1]))
        return hit[1], best

    linked, unmatched = [], []
    stats = defaultdict(int)
    for n, f in enumerate(adm3):
        geom = shape(f["geometry"])
        if not geom.is_valid:
            geom = geom.buffer(0)
        name = f["properties"]["shapeName"]
        reg = parent(geom, t1, r1_geoms, r1_names)
        dist = parent(geom, t2, r2_geoms, r2_names)
        wn, dk = ward_key(name), district_key(dist or "")

        score, key = pick(by_region.get(region_key(reg or ""), []), wn, dk)
        how = "in-region"

        # Fallback: the assigned region may be wrong near region borders.
        if key is None and wn in by_ward:
            cands = by_ward[wn]
            if len({k[0] for k in cands}) == 1:
                score, key, how = 100, max(cands, key=lambda k: fuzz.WRatio(dk, k[1])), "name-unique"

        rec = {
            "shapeID": f["properties"]["shapeID"],
            "gb_ward": name, "gb_region": reg, "gb_district": dist,
            "score": round(score, 1), "how": how,
        }
        if key:
            R, D, W = meta[key]
            rec.update(region=R, district=D, ward=W,
                       villages=sorted(set(villages[key])))
            linked.append(rec)
            stats[how] += 1
        else:
            unmatched.append(rec)
        if (n + 1) % 1000 == 0:
            print(f"  ...{n + 1}/{len(adm3)}")

    exact = sum(1 for r in linked if r["score"] == 100)
    print(f"\nlinked   : {len(linked)}/{len(adm3)}  exact {exact}, fuzzy {len(linked)-exact}")
    print(f"           by route: {dict(stats)}")
    print(f"unmatched: {len(unmatched)}")

    covered = {(r["region"], r["district"], r["ward"]) for r in linked}
    print(f"data.json wards with a polygon: {len(covered)}/{len(meta)}")

    dupes = len(linked) - len(covered)
    if dupes:
        print(f"  note: {dupes} polygons share a ward key with another polygon")

    (ROOT / "build" / "linked.json").write_text(json.dumps(linked))
    (ROOT / "build" / "unmatched.json").write_text(json.dumps(unmatched, indent=1))
    print("\nsample unmatched:")
    for r in unmatched[:12]:
        print(f"  {r['gb_ward']!r:26} score={r['score']:5}  region={r['gb_region']!r}")


if __name__ == "__main__":
    main()
