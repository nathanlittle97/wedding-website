import re
import unicodedata


def _norm(value):
    """Lower-case, strip accents, drop apostrophes, treat hyphens as spaces."""
    text = unicodedata.normalize("NFKD", str(value))
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.casefold().replace("'", "").replace("\u2019", "").replace("-", " ")
    return re.sub(r"\s+", " ", text).strip()


def guest_key(first, last):
    """Stable identity for a guest: 'Sam O'Brien' and 'sam obrien' match."""
    return f"{_norm(first)}|{_norm(last)}"
