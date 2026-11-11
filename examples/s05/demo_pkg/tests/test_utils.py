"""Tests for demo_pkg.utils.

Run from the ``examples/s05`` directory:

    python -m pytest demo_pkg/tests -v
"""

import sys
from pathlib import Path

# Allow running pytest from anywhere: put examples/s05 on sys.path so
# ``import demo_pkg`` resolves without needing an installed package.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest

from demo_pkg.utils import add, is_palindrome, repeat


class TestAdd:
    """add() should sum numbers."""

    def test_integers(self) -> None:
        assert add(2, 3) == 5

    def test_floats(self) -> None:
        assert add(0.5, 0.25) == pytest.approx(0.75)

    def test_negative(self) -> None:
        assert add(-4, 4) == 0


class TestRepeat:
    """repeat() should join copies with a separator."""

    def test_default_twice(self) -> None:
        assert repeat("ab") == "ab ab"

    def test_custom_times_and_sep(self) -> None:
        assert repeat("x", times=3, sep="-") == "x-x-x"

    def test_zero_times_returns_empty(self) -> None:
        assert repeat("hi", times=0) == ""

    def test_negative_times_returns_empty(self) -> None:
        assert repeat("hi", times=-2) == ""


class TestIsPalindrome:
    """is_palindrome() ignores case and non-alphanumeric chars."""

    @pytest.mark.parametrize(
        "text",
        ["racecar", "A man, a plan, a canal: Panama", "No 'x' in Nixon"],
    )
    def test_true_cases(self, text: str) -> None:
        assert is_palindrome(text) is True

    @pytest.mark.parametrize("text", ["hello", "Python", "ab"])
    def test_false_cases(self, text: str) -> None:
        assert is_palindrome(text) is False

    def test_empty_string_is_palindrome(self) -> None:
        assert is_palindrome("") is True
