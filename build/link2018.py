"""Link the 2018 NBS/OCHA ward polygons to data.json.

Unlike the 2015 OSM source, these carry ADM1/ADM2/ADM3 names and official
P-codes, so the ward can be matched on its full hierarchy rather than deriving
parents spatially.

Wards that match data.json get its village list. Wards in regions data.json does
not know about at all -- Songwe, created in 2016 -- are kept without villages, so
someone standing there is told the right region instead of the pre-2016 answer.

Outputs build/linked_2018.json.
"""
import json
import unicodedata
from collections import defaultdict
from pathlib import Path

from rapidfuzz import fuzz, process

from link import district_key, region_key

ROOT = Path(__file__).resolve().parent.parent
WARD_SCORE_MIN = 88

# Swahili and Roman numerals appear as words in one source and digits in the
# other (Daraja Mbili / Daraja 2).
NUMERALS = {
    "moja": "1", "mbili": "2", "tatu": "3", "nne": "4", "tano": "5",
    "sita": "6", "saba": "7", "nane": "8", "tisa": "9", "kumi": "10",
    "i": "1", "ii": "2", "iii": "3", "iv": "4", "vi": "6",
}
DROP = {"ward", "shehia", "mtaa", "kata"}


def wkey(s):
    """Ward key: apostrophes removed rather than split on (Ngh'ongh'onha vs
    Ng'hong'honha), numerals folded to digits, designator words dropped."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("'", "").replace("`", "").replace("’", "")
    s = "".join(c if c.isalnum() else " " for c in s)
    return " ".join(NUMERALS.get(t, t) for t in s.split() if t not in DROP)


def main():
    rows = json.loads((ROOT / "data.json").read_text())
    feats = json.loads((ROOT / "build" / "adm3_2018_simp.geojson").read_text())["features"]

    meta, villages, by_region = {}, defaultdict(list), defaultdict(list)
    for r in rows:
        if not all(str(r[k]).strip() for k in r):
            continue
        k = (region_key(r["Region"]), district_key(r["District"]), wkey(r["Ward_Shehia"]))
        if k not in meta:
            meta[k] = (r["Region"], r["District"], r["Ward_Shehia"])
            by_region[k[0]].append(k)
        villages[k].append(r["Village_Mtaa"])

    dj_regions = set(by_region)
    out, stats = [], defaultdict(int)

    for f in feats:
        p = f["properties"]
        rk = region_key(p["ADM1_EN"])
        dk, wk = district_key(p["ADM2_EN"]), wkey(p["ADM3_EN"])
        rec = {
            "pcode": p["ADM3_PCODE"],
            "adm1": p["ADM1_EN"], "adm2": p["ADM2_EN"], "adm3": p["ADM3_EN"],
        }

        key = None
        if (rk, dk, wk) in meta:
            key, how = (rk, dk, wk), "exact"
        else:
            same = [k for k in by_region.get(rk, []) if k[2] == wk]
            if same:
                key, how = same[0], "region+ward"
            else:
                cands = by_region.get(rk, [])
                hit = process.extractOne(wk, [k[2] for k in cands],
                                         scorer=fuzz.WRatio) if cands else None
                if hit and hit[1] >= WARD_SCORE_MIN:
                    tied = [k for k in cands if k[2] == hit[0]]
                    key, how = max(tied, key=lambda k: fuzz.WRatio(dk, k[1])), "fuzzy"

        if key:
            R, D, W = meta[key]
            rec.update(region=R, district=D, ward=W,
                       villages=sorted(set(villages[key])), how=how)
            stats[how] += 1
        elif rk not in dj_regions:
            # A region data.json has never heard of (Songwe). Keep it, using the
            # official names, so at least the region/district/ward are right.
            rec.update(region=p["ADM1_EN"], district=p["ADM2_EN"], ward=p["ADM3_EN"],
                       villages=[], how="new-region")
            stats["new-region"] += 1
        else:
            rec["how"] = "unmatched"
            stats["unmatched"] += 1
        out.append(rec)

    kept = [r for r in out if r["how"] != "unmatched"]
    covered = {(r["region"], r["district"], r["ward"]) for r in kept if r["villages"]}
    print(f"2018 polygons     : {len(feats)}")
    print(f"  matched to data.json: {stats['exact']} exact, "
          f"{stats['region+ward']} region+ward, {stats['fuzzy']} fuzzy")
    print(f"  new regions kept    : {stats['new-region']} "
          f"({', '.join(sorted({r['adm1'] for r in out if r['how']=='new-region'}))})")
    print(f"  unmatched (dropped) : {stats['unmatched']}")
    print(f"  data.json wards with a 2018 polygon: {len(covered)}/{len(meta)} "
          f"({100*len(covered)/len(meta):.1f}%)")

    (ROOT / "build" / "linked_2018.json").write_text(json.dumps(kept))


if __name__ == "__main__":
    main()
