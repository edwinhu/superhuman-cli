#!/usr/bin/env bash
# Regression tests for scripts/cdp-substrate-gate.sh.
#
# These exist because the gate previously reported PASS on G1 (drift) when its
# input files were missing/unreadable: `sed` on an unreadable file silently
# writes an empty output file, and `diff -q` on two empty files succeeds.
#
# Run: bash scripts/cdp-substrate-gate.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/cdp-substrate-gate.sh"
fails=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails+1)); }

# --- Test 1: gate must FAIL (nonzero exit) when a repo path is missing/unreadable ---
out1=$(MORGEN_REPO=/tmp/cdp-gate-test-does-not-exist \
       SUPERHUMAN_REPO=/tmp/cdp-gate-test-does-not-exist \
       bash "$GATE" 2>&1)
rc1=$?
if [ "$rc1" -ne 0 ]; then
  pass "test1: nonzero exit when repo paths missing (rc=$rc1)"
else
  fail "test1: expected nonzero exit when repo paths missing, got rc=0"
fi
if echo "$out1" | grep -qi 'PASS identical (0 lines)'; then
  fail "test1: vacuous 'PASS identical (0 lines)' still present with missing repos"
else
  pass "test1: no vacuous 'PASS identical (0 lines)' output"
fi

# --- Test 2: gate must FAIL when the END PRODUCT BLOCK marker is absent ---
tmpA=$(mktemp -d)
tmpB=$(mktemp -d)
mkdir -p "$tmpA/src" "$tmpB/src"
# Real content, but with the marker comment stripped from one side.
printf 'export const x = 1;\n// no marker here\nexport const y = 2;\n' > "$tmpA/src/cdp-endpoint.ts"
printf 'export const x = 1;\n// no marker here\nexport const y = 2;\n' > "$tmpB/src/cdp-endpoint.ts"
out2=$(MORGEN_REPO="$tmpA" SUPERHUMAN_REPO="$tmpB" bash "$GATE" 2>&1)
rc2=$?
rm -rf "$tmpA" "$tmpB"
if [ "$rc2" -ne 0 ]; then
  pass "test2: nonzero exit when END PRODUCT BLOCK marker is absent (rc=$rc2)"
else
  fail "test2: expected nonzero exit when marker absent, got rc=0"
fi
if echo "$out2" | grep -qi 'PASS identical (0 lines)'; then
  fail "test2: vacuous 'PASS identical (0 lines)' still present with no marker"
else
  pass "test2: no vacuous 'PASS identical (0 lines)' output"
fi

# --- Test 3: gate must PASS on the real, current, correct repos ---
out3=$(bash "$GATE" 2>&1)
rc3=$?
if [ "$rc3" -eq 0 ]; then
  pass "test3: gate exits 0 on real repos"
else
  fail "test3: expected exit 0 on real repos, got rc=$rc3"
  echo "$out3"
fi

echo ""
if [ "$fails" -eq 0 ]; then
  echo "ALL TESTS PASS"
  exit 0
else
  echo "$fails TEST(S) FAILED"
  exit 1
fi
