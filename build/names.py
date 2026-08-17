"""Normalising place names so three differently-spelled sources can be joined.

data.json writes "Dar es Salaam Region" and "Kalamba Ward"; the NBS 2022 census
shapefile writes "Dar es Salaam" and "Kalamba"; tanzaniapostcode.com writes
"unguja-north" where both of the others say "Kaskazini Unguja". Everything here
exists to fold those onto one key.

Getting this wrong is expensive and quiet: the trailing " Ward"/" Shehia" that
data.json appends once cost about 75% of all postcode matches, because every
comparison failed against a source that omits it.
"""
import unicodedata

REGION_ALIASES = {
    # data.json suffixes
    "dar es salaam region": "dar es salaam",
    "mtwara region": "mtwara",
    "pwani region": "pwani",
    "coast": "pwani",
    # English names for Zanzibar -> Swahili canonical
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

# Designators data.json appends to ward names and other sources do not.
WARD_SUFFIXES = (" ward", " shehia")

# Swahili/English district-type equivalents, for telling apart two wards that
# share a name inside one region.
DISTRICT_TOKENS = {
    "urban": "mjini", "rural": "vijijini", "town": "mji",
    "municipal": "manispaa", "council": "", "district": "", "dc": "", "tc": "",
    # NBS council names: "Halmashauri ya Manispaa ya Ubungo", "Baraza la
    # Manispaa Mjini", "Halmashauri ya Jiji la Dodoma".
    "halmashauri": "", "baraza": "", "ya": "", "la": "", "wa": "", "wilaya": "",
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
    """Reduce a district or full council name to its distinguishing word(s).

    "Halmashauri ya Manispaa ya Ubungo" and "Ubungo" both become "ubungo".
    """
    toks = [DISTRICT_TOKENS.get(t, t) for t in norm(s).split()]
    return " ".join(t for t in toks if t)


def region_key(s):
    n = norm(s)
    return REGION_ALIASES.get(n, n)
