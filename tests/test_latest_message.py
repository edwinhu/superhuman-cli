"""
pytest suite for the `inbox --with-body` latest-message extraction.

These tests exercise the real production code path
(getThreadBodiesFromDB + extractLatestMessage) against the live local
Superhuman SQLite cache via scripts/latest-message-probe.ts.

They assert that the quote-stripped "latest message" is the NEWEST author's
new content, free of the quoted reply chain that fools the morning-briefing
needs-reply heuristic.

Run:  python3 -m pytest tests/test_latest_message.py -v

Known fixture threads on eddyhu@gmail.com:
  - 19ebc78d1f31ac12  sleep.me "Leak" thread; true latest = Dawn R's
                      "normal functioning unit" closeout.
  - 19ec351e56c4bcae  muni thread; true latest = Yashar Barardehi's
                      "what are we thinking", NOT the quoted 2024 Zoom link.

If the local SQLite cache does not contain a fixture thread (fresh machine,
cleared cache), that thread's test is skipped rather than failed.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PROBE = REPO / "scripts" / "latest-message-probe.ts"
ACCOUNT = "eddyhu@gmail.com"

SLEEP_ME = "19ebc78d1f31ac12"
MUNI = "19ec351e56c4bcae"


def _bun() -> str:
    bun = shutil.which("bun")
    if not bun:
        pytest.skip("bun not on PATH")
    return bun


def probe(*thread_ids: str) -> dict[str, str]:
    """Run the probe and return {threadId: latestMessage}."""
    proc = subprocess.run(
        [_bun(), str(PROBE), ACCOUNT, *thread_ids],
        cwd=str(REPO),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, f"probe failed: {proc.stderr}"
    out: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        out[rec["id"]] = rec["latestMessage"]
    return out


def _require(latest: str, thread_id: str) -> str:
    if not latest.strip():
        pytest.skip(f"thread {thread_id} not in local SQLite cache")
    return latest


def test_sleep_me_latest_is_closeout():
    latest = _require(probe(SLEEP_ME)[SLEEP_ME], SLEEP_ME)
    # Dawn R's closeout is the newest message.
    assert "normal functioning unit" in latest
    # No quoted reply-chain markers leaked through.
    assert "On " not in latest or "wrote:" not in latest
    assert "From:" not in latest


def test_muni_latest_is_yashar_not_zoom_link():
    latest = _require(probe(MUNI)[MUNI], MUNI)
    # Yashar's new content is present.
    assert "what are we thinking" in latest
    assert "Yash" in latest
    # The quoted 2024 Zoom link / Outlook header block must be stripped.
    assert "zoom.us" not in latest.lower()
    assert "From:" not in latest
    assert "Sent:" not in latest
    assert "Subject:" not in latest
    assert "External Message" not in latest


def test_muni_strips_only_quote_not_signoff():
    latest = _require(probe(MUNI)[MUNI], MUNI)
    # Signoff before the quote block is preserved; quoted history after is gone.
    assert latest.rstrip().endswith("Yash")


# --- Synthetic, DB-independent coverage (always runs) ------------------------

# Private-use message-break delimiter Superhuman uses in the FTS body (U+F8FF).
SEP = chr(0xF8FF)


def probe_raw(body: str) -> str:
    proc = subprocess.run(
        [_bun(), str(PROBE), "--raw"],
        cwd=str(REPO),
        input=body,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, f"probe --raw failed: {proc.stderr}"
    return proc.stdout


def test_takes_last_nonempty_segment():
    body = f"oldest message{SEP}middle message{SEP}newest message{SEP} "
    assert probe_raw(body).strip() == "newest message"


def test_strips_on_wrote_block():
    seg = (
        "Sounds good, let's proceed.\n\n"
        "On Mon, Jun 9, 2026 at 3:14 PM Jane Doe <jane@x.com> wrote:\n"
        "> here is the old stuff\n> more old stuff\n"
    )
    out = probe_raw(seg)
    assert out.strip() == "Sounds good, let's proceed."
    assert "wrote:" not in out
    assert ">" not in out


def test_strips_outlook_header_block():
    seg = (
        "Here is my reply.\n\n"
        "From: Someone <a@b.com>\n"
        "Sent: Tuesday, December 10, 2024 2:38 PM\n"
        "To: Me <me@x.com>\n"
        "Subject: old subject\n\n"
        "old quoted body here\n"
    )
    out = probe_raw(seg)
    assert out.strip() == "Here is my reply."
    assert "From:" not in out and "Sent:" not in out


def test_no_quote_returns_full_text():
    seg = "Just a plain message with no quoted history at all."
    assert probe_raw(seg).strip() == seg


def test_strips_gt_quoted_lines():
    seg = "My new line.\n> quoted line 1\n> quoted line 2"
    assert probe_raw(seg).strip() == "My new line."
