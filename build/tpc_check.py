"""Sanity-check tanzaniapostcode.com against an independent source.

Its sitemap encodes every record as region-district-ward-location-POSTCODE.html,
so the whole dataset is readable without crawling the site.

The site is a third-party aggregator, not Tanzania Posts Corporation, so before
trusting it we compare its region-level prefixes against the 913 well-formed
OSM postcode tags that fall inside Tanzania -- two sources with no common
origin. Agreement across many regions would be hard to get by chance.
"""
import glob
import gzip
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

REGION_SLUGS = [
    "dar-es-salaam", "mjini-magharibi", "pemba-north", "pemba-south",
    "unguja-north", "unguja-south", "kilimanjaro", "shinyanga", "morogoro",
    "singida", "arusha", "dodoma", "geita", "iringa", "kagera", "katavi",
    "kigoma", "lindi", "manyara", "mara", "mbeya", "mtwara", "mwanza",
    "njombe", "pwani", "rukwa", "ruvuma", "simiyu", "songwe", "tabora", "tanga",
]
REGION_SLUGS.sort(key=len, reverse=True)   # longest first: pemba-north before ...


def main():
    urls = []
    for f in glob.glob(str(ROOT / "build" / "raw" / "tpc" / "*")):
        data = (gzip.open(f, "rt", errors="replace") if f.endswith(".gz")
                else open(f, errors="replace")).read()
        urls += re.findall(r"<loc>(.*?)</loc>", data)

    rows, unparsed = [], 0
    for u in urls:
        m = re.search(r"/([a-z0-9-]+)-(\d{5})\.html$", u)
        if not m:
            continue
        slug, pc = m.group(1), m.group(2)
        region = next((r for r in REGION_SLUGS if slug.startswith(r + "-")), None)
        if not region:
            unparsed += 1
            continue
        rows.append((region, pc))

    print(f"records parsed from sitemap: {len(rows)}   unparsed: {unparsed}")
    print(f"distinct postcodes         : {len(set(p for _, p in rows))}")

    site = {}
    for region, pc in rows:
        site.setdefault(region, Counter())[pc[:2]] += 1

    print(f"\n{'region':18}{'n':>7}  prefix(es) per region")
    multi = 0
    for r, c in sorted(site.items()):
        tot = sum(c.values())
        top = c.most_common(3)
        if len(c) > 1:
            multi += 1
        print(f"  {r:16}{tot:>7}  {dict(top)}")
    print(f"\nregions whose codes use more than one prefix: {multi}/{len(site)}")

    # --- cross-check against OSM ---
    osm_prefix = {
        "arusha": "23", "songwe": "35", "iringa": "51", "tanga": "21",
        "morogoro": "67", "mjini-magharibi": "71", "kilimanjaro": "25",
        "unguja-south": "72", "mara": "31", "kigoma": "47",
    }
    print("\ncross-check vs independent OSM sample (10 regions OSM was confident on):")
    agree = 0
    for r, want in sorted(osm_prefix.items()):
        got = site.get(r, Counter()).most_common(1)
        got = got[0][0] if got else "-"
        ok = got == want
        agree += ok
        print(f"  {r:18} osm={want}  site={got}  {'match' if ok else 'MISMATCH'}")
    print(f"\n  {agree}/{len(osm_prefix)} agree")


if __name__ == "__main__":
    main()
