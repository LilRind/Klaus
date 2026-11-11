"""Utility helpers for demo_pkg."""


def add(a: float, b: float) -> float:
    """Return the sum of two numbers.

    Args:
        a: First addend.
        b: Second addend.

    Returns:
        The sum of ``a`` and ``b``.
    """
    return a + b


def repeat(text: str, times: int = 2, sep: str = " ") -> str:
    """Repeat a string, joining copies with a separator.

    Args:
        text: The string to repeat.
        times: How many copies to make (>= 1 expected).
        sep: Separator inserted between copies.

    Returns:
        The repeated string. If ``times`` < 1, returns ``""``.
    """
    if times < 1:
        return ""
    return sep.join(text for _ in range(times))


def is_palindrome(text: str) -> bool:
    """Check whether ``text`` reads the same forwards and backwards.

    Comparison is case-insensitive and ignores non-alphanumeric
    characters, so phrases like "A man, a plan..." count as palindromes.

    Args:
        text: The string to check.

    Returns:
        True if ``text`` is a palindrome, False otherwise.
    """
    cleaned = "".join(ch.lower() for ch in text if ch.isalnum())
    return cleaned == cleaned[::-1]
