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

Outputs build/ward_postcodes.json: "<region key>|<ward key>" -> "12345", keyed
the way build/nbs2022.py joins. Keying on data.json's own Region/District/Ward
triple used to cap coverage at whatever data.json happened to contain -- Songwe,
absent from it entirely, could never receive a postcode however many the sitemap
listed.
"""
import glob
import gzip
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

from names import district_key, region_key, ward_key

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
    # The authoritative ward list, so every ward that exists can receive a code.
    feats = json.loads((ROOT / "build" / "nbs2022_simp.geojson").read_text())["features"]

    # region -> ward slug -> [(output key, district slugs that identify it)],
    # longest slug first so a ward whose name contains a shorter ward's name
    # still wins.
    by_ward = defaultdict(lambda: defaultdict(list))
    regions = set()
    for f in feats:
        p = f["properties"]
        rk = region_key(p["reg_name"])
        regions.add(rk)
        key = f"{rk}|{ward_key(p['ward_name'])}"
        dslugs = {slug(p["dist_name"]), slug(district_key(p["counc_name"]))}
        by_ward[rk][wslug(p["ward_name"])].append((key, dslugs))
    ward_order = {rk: sorted(d, key=len, reverse=True) for rk, d in by_ward.items()}

    region_by_slug = {}
    for rk in regions:
        region_by_slug[slug(rk)] = rk
    # their slugs, canonicalised through the same alias table
    for extra in ["unguja-north", "unguja-south", "pemba-north", "pemba-south",
                  "dar-es-salaam", "mtwara", "pwani"]:
        rk = region_key(extra.replace("-", " "))
        if rk in regions:
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
            # Same ward name in two councils of one region: the district slug in
            # their URL is the only thing that can separate them.
            better = [c for c in cands
                      if any(rest.startswith(d + "-") for d in c[1] if d)]
            if len({c[0] for c in better}) == 1:
                cands = better
            else:
                stats["ambiguous ward"] += 1
                continue

        votes[cands[0][0]][pc] += 1
        stats["matched"] += 1

    print("sitemap records :", stats["records"])
    for k in ("matched", "no region", "no ward", "ambiguous ward"):
        print(f"  {k:12}: {stats[k]}")

    # A handful of regions have two distinct wards sharing a name, which collapse
    # onto one key. Their codes differ, and nothing in the sitemap URL reliably
    # tells them apart, so both are dropped -- no postcode beats the wrong one.
    seen = Counter(f"{region_key(f['properties']['reg_name'])}|"
                   f"{ward_key(f['properties']['ward_name'])}" for f in feats)
    collisions = {k for k, n in seen.items() if n > 1}

    out, conflicts, dropped_dupe = {}, 0, 0
    for key, c in votes.items():
        if key in collisions:
            dropped_dupe += 1
            continue
        pc, n = c.most_common(1)[0]
        if len(c) > 1 and n / sum(c.values()) < 0.9:
            conflicts += 1
            continue
        out[key] = pc

    total_wards = len({f"{region_key(f['properties']['reg_name'])}|"
                       f"{ward_key(f['properties']['ward_name'])}" for f in feats})
    print(f"\nwards with a postcode: {len(out)}/{total_wards} "
          f"({100*len(out)/total_wards:.1f}%)")
    print(f"  wards where codes disagreed and were dropped: {conflicts}")
    print(f"  ward names shared inside one region, dropped: {dropped_dupe}"
          f" (from {len(collisions)} colliding names)")
    print(f"  distinct postcodes: {len(set(out.values()))}")

    (ROOT / "build" / "ward_postcodes.json").write_text(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
