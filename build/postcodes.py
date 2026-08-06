"""Attach a postcode to each ward, from tanzaniapostcode.com.

Their sitemap encodes every record in the URL itself:

    /arusha-arumeru-akheri-akheri-23306.html
     region district ward   location postcode

so the whole dataset comes from one sitemap download -- the site is never
crawled. The postcode is constant across a ward's locations, which is why this
joins at ward level.

Splitting the slug is ambiguous because names contain hyphens themselves
(Nyang'hwale -> nyang-hwale), so rather than fetching their index pages we match
greedily against our own region/district/ward names, longest first.

Outputs build/ward_postcodes.json: "Region|District|Ward" -> "12345"
"""
import glob
import gzip
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

from link import region_key

ROOT = Path(__file__).resolve().parent.parent


def slug(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s)).strip("-")


def wslug(s):
    """Ward slug without the designator data.json appends. Ours reads
    'Kalamba Ward'; theirs is just 'kalamba'."""
    return re.sub(r"-(ward|shehia|mtaa)$", "", slug(s))


def main():
    # Build the hierarchy from the same inputs web_data.py uses, so this can run
    # before it rather than depending on its output.
    rows = json.loads((ROOT / "data.json").read_text())
    linked18 = json.loads((ROOT / "build" / "linked_2018.json").read_text())

    wards = defaultdict(lambda: defaultdict(dict))
    def add(region, district, ward):
        wards[region_key(region)][slug(district)][wslug(ward)] = (region, district, ward)

    for r in rows:
        if all(str(r[k]).strip() for k in r):
            add(r["Region"], r["District"], r["Ward_Shehia"])
    for rec in linked18:                      # wards from regions data.json lacks
        if rec["how"] == "new-region":
            add(rec["region"], rec["district"], rec["ward"])

    # region -> ward slug -> [(Region, District, Ward)], longest slug first so
    # a ward whose name contains a shorter ward's name still wins.
    by_ward = defaultdict(lambda: defaultdict(list))
    for rk, ds in wards.items():
        for dslug, ws in ds.items():
            for ws_key, triple in ws.items():
                by_ward[rk][ws_key].append(triple)
    ward_order = {rk: sorted(d, key=len, reverse=True) for rk, d in by_ward.items()}

    region_by_slug = {}
    for rk in wards:
        region_by_slug[slug(rk)] = rk
    # their slugs, canonicalised through the same alias table
    for extra in ["unguja-north", "unguja-south", "pemba-north", "pemba-south",
                  "dar-es-salaam", "mtwara", "pwani"]:
        rk = region_key(extra.replace("-", " "))
        if rk in wards:
            region_by_slug[extra] = rk
    order = sorted(region_by_slug, key=len, reverse=True)

    urls = []
    for f in glob.glob(str(ROOT / "build" / "raw" / "tpc" / "*")):
        data = (gzip.open(f, "rt", errors="replace") if f.endswith(".gz")
                else open(f, errors="replace")).read()
        urls += re.findall(r"<loc>(.*?)</loc>", data)

    votes = defaultdict(Counter)
    stats = Counter()
    for u in urls:
        m = re.search(r"/([a-z0-9-]+)-(\d{5})\.html$", u)
        if not m:
            continue
        rest, pc = m.group(1), m.group(2)
        stats["records"] += 1

        rslug = next((r for r in order if rest.startswith(r + "-")), None)
        if not rslug:
            stats["no region"] += 1
            continue
        rk = region_by_slug[rslug]
        rest = rest[len(rslug) + 1:]

        # Their district names differ from ours (their "arumeru" is our "meru"),
        # so match on region + ward and use the district only to break ties.
        hit = next((w for w in ward_order[rk]
                    if rest.startswith(w + "-") or f"-{w}-" in rest), None)
        if not hit:
            stats["no ward"] += 1
            continue

        cands = by_ward[rk][hit]
        if len(cands) > 1:
            better = [c for c in cands if rest.startswith(slug(c[1]) + "-")]
            if len(better) == 1:
                cands = better
            else:
                stats["ambiguous ward"] += 1
                continue

        votes["|".join(cands[0])][pc] += 1
        stats["matched"] += 1

    print("sitemap records :", stats["records"])
    for k in ("matched", "no region", "no ward", "ambiguous ward"):
        print(f"  {k:12}: {stats[k]}")

    out, conflicts = {}, 0
    for key, c in votes.items():
        pc, n = c.most_common(1)[0]
        if len(c) > 1 and n / sum(c.values()) < 0.9:
            conflicts += 1
            continue
        out[key] = pc

    total_wards = sum(len(w) for r in wards.values() for w in r.values())
    print(f"\nwards with a postcode: {len(out)}/{total_wards} "
          f"({100*len(out)/total_wards:.1f}%)")
    print(f"  wards where codes disagreed and were dropped: {conflicts}")
    print(f"  distinct postcodes: {len(set(out.values()))}")

    (ROOT / "build" / "ward_postcodes.json").write_text(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
