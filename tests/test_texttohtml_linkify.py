"""
pytest suite for textToHtml / linkifyUrls (src/superhuman-api.ts).

Exercises the REAL production helper used to build reply/draft bodies, via
scripts/texttohtml-probe.ts. Covers the two confirmed bugs this branch fixes:

  1. Bare URLs in --body must be wrapped in a clickable <a> tag (they used to
     land as literal text).
  2. textToHtml must leave existing HTML (the --html path) untouched.

Run:  python3 -m pytest tests/test_texttohtml_linkify.py -v
"""
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PROBE = REPO / "scripts" / "texttohtml-probe.ts"


def _bun() -> str:
    bun = shutil.which("bun")
    if not bun:
        pytest.skip("bun not on PATH")
    return bun


def html(text: str) -> str:
    proc = subprocess.run(
        [_bun(), str(PROBE)],
        cwd=str(REPO),
        input=text,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, f"probe failed: {proc.stderr}"
    return proc.stdout


def linkify(text: str) -> str:
    proc = subprocess.run(
        [_bun(), str(PROBE), "--linkify"],
        cwd=str(REPO),
        input=text,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, f"probe failed: {proc.stderr}"
    return proc.stdout


# --- linkify of bare URLs (bug #2) ------------------------------------------

def test_bare_url_becomes_anchor():
    out = html("https://calendar.superhuman.com/meet/abc123")
    assert '<a href="https://calendar.superhuman.com/meet/abc123">' in out
    assert "</a>" in out


def test_url_inline_with_text():
    out = html("Book a slot: https://example.com/x here")
    assert '<a href="https://example.com/x">https://example.com/x</a>' in out
    assert "Book a slot:" in out
    assert " here" in out


def test_trailing_period_left_outside_link():
    out = linkify("See https://example.com/page.")
    assert '<a href="https://example.com/page">https://example.com/page</a>.' in out
    # The period must NOT be part of the href.
    assert 'href="https://example.com/page."' not in out


def test_trailing_comma_left_outside_link():
    out = linkify("Visit https://example.com, then leave")
    assert '<a href="https://example.com">https://example.com</a>,' in out


def test_multiple_urls_all_linkified():
    out = linkify("a https://one.com b https://two.com")
    assert out.count("<a href=") == 2
    assert 'href="https://one.com"' in out
    assert 'href="https://two.com"' in out


def test_no_url_is_plain_paragraph():
    out = html("just some text")
    assert out == "<p>just some text</p>"


def test_url_with_query_and_fragment_preserved():
    url = "https://example.com/p?q=1&r=2#frag"
    out = linkify(url)
    assert f'<a href="{url}">{url}</a>' == out


# --- HTML passthrough (bug #1: --html path must be verbatim) -----------------

def test_existing_html_passthrough():
    snippet = '<a href="https://x.com/book">Book a 30-minute slot</a>'
    out = html(snippet)
    # Returned verbatim — no <p> wrapping, no double-linkify of the href.
    assert out == snippet


def test_html_with_anchor_not_double_linkified():
    snippet = '<p>Click <a href="https://x.com">here</a></p>'
    assert html(snippet) == snippet


# --- paragraphs --------------------------------------------------------------

def test_newlines_become_paragraphs():
    out = html("line one\nline two")
    assert out == "<p>line one</p><p>line two</p>"
