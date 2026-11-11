"""Standard-library helpers for building URL-friendly slugs from arbitrary text.

This module intentionally has no third-party dependencies; it relies only on
``re`` and ``unicodedata`` from the Python standard library.
"""

from __future__ import annotations

import re
import unicodedata

# Matches any run of characters that is *not* an ASCII letter or digit.
# Input is already lowercased/casefolded before this runs, so [a-z0-9]
# is sufficient (and keeps slugs safe for URLs).
_NON_ALNUM_RUN_RE = re.compile(r"[^a-z0-9]+")


def slugify(text: str) -> str:
    """Convert arbitrary text into a URL-friendly slug.

    The conversion pipeline is:

    1. Unicode NFKD normalization, which decomposes accented characters
       (``e`` + combining accent) and collapses compatibility forms
       (full-width letters -> ASCII, ``1`` -> ``1``).
    2. Drop combining marks, so accents disappear: ``e`` -> ``e``,
       ``u`` -> ``u``.
    3. Lowercase via ``str.casefold()`` (aggressive lowercasing; also maps
       e.g. German ``ss`` to ``ss``).
    4. Replace every run of characters that is not alphanumeric with a
       single hyphen ``-``.
    5. Strip leading and trailing hyphens.

    Empty input, or input containing only symbols/punctuation, yields an
    empty string rather than raising an error.

    Args:
        text: Arbitrary input text (may be empty).

    Returns:
        A lowercase slug of ASCII letters and digits joined by single
        hyphens, with no leading or trailing hyphens.

    Examples:
        >>> slugify("Hello, World!")
        'hello-world'
        >>> slugify("Crème brûlée à la carte")
        'creme-brulee-a-la-carte'
        >>> slugify("  Multiple   spaces & symbols!!! ")
        'multiple-spaces-symbols'
        >>> slugify("")
        ''
        >>> slugify("@#$%^&*")
        ''
    """
    # 1. Decompose: "é" -> "e" + U+0301 (combining acute accent), etc.
    decomposed = unicodedata.normalize("NFKD", text)
    # 2. Remove combining marks so accents vanish entirely.
    without_accents = "".join(
        ch for ch in decomposed if not unicodedata.combining(ch)
    )
    # 3. Lowercase (casefold also folds special cases like "ß" -> "ss").
    lowered = without_accents.casefold()
    # 4. Collapse each run of non-alphanumerics into a single hyphen.
    slug = _NON_ALNUM_RUN_RE.sub("-", lowered)
    # 5. Trim leading/trailing hyphens (no-op for empty/all-symbol input).
    return slug.strip("-")


if __name__ == "__main__":
    import sys

    # Some Windows consoles default to a non-UTF-8 code page (e.g. GBK);
    # reconfigure stdout so accented demo output never crashes.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    demo_cases = [
        "Hello, World!",                      # plain text with punctuation
        "Crème brûlée à la carte",            # accented text
        "  Mix3d -- Symbols &   spaces!!! ",  # mixed symbols/whitespace/digits
        "",                                   # empty string
        "@#$%^&*",                            # all symbols
    ]
    for sample in demo_cases:
        print(f"{sample!r} -> {slugify(sample)!r}")
