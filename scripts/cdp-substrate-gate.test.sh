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
# Hermetic: pass MORGEN_REPO/SUPERHUMAN_REPO explicitly so this does not
# depend on the hardcoded worktree default (which vanishes once the branch
# merges and the worktree is removed).
: "${MORGEN_REPO:=/home/eh/projects/morgen-cli/.claude/worktrees/endpoint-discovery}"
: "${SUPERHUMAN_REPO:=$HERE/..}"
SUPERHUMAN_REPO="$(cd "$SUPERHUMAN_REPO" && pwd)"
out3=$(MORGEN_REPO="$MORGEN_REPO" SUPERHUMAN_REPO="$SUPERHUMAN_REPO" bash "$GATE" 2>&1)
rc3=$?
if [ "$rc3" -eq 0 ]; then
  pass "test3: gate exits 0 on real repos with explicit MORGEN_REPO/SUPERHUMAN_REPO"
else
  fail "test3: expected exit 0 on real repos, got rc=$rc3"
  echo "$out3"
fi

# --- Test 4: gate must FAIL (not vacuously PASS) when tsc cannot run (G4) ---
stubdir=$(mktemp -d)
cat > "$stubdir/bunx" <<'STUB'
#!/usr/bin/env bash
# Simulate a broken/missing tsc install: bunx itself fails, no tsc output at all.
echo "bunx: command not found (stub)" >&2
exit 127
STUB
chmod +x "$stubdir/bunx"
out4=$(PATH="$stubdir:$PATH" MORGEN_REPO="$MORGEN_REPO" SUPERHUMAN_REPO="$SUPERHUMAN_REPO" bash "$GATE" 2>&1)
rc4=$?
rm -rf "$stubdir"
if [ "$rc4" -ne 0 ]; then
  pass "test4: nonzero exit when bunx/tsc cannot run (rc=$rc4)"
else
  fail "test4: expected nonzero exit when bunx/tsc cannot run, got rc=0"
fi
if echo "$out4" | grep -qE 'PASS[[:space:]]+(morgen|superhuman) 0$'; then
  fail "test4: vacuous 'PASS ... 0' still present when tsc never ran"
else
  pass "test4: no vacuous tsc-never-ran PASS output"
fi

# --- Test 5: gate must FAIL (not vacuously PASS) when the test runner cannot run (G3) ---
stubdir=$(mktemp -d)
cat > "$stubdir/bun" <<'STUB'
#!/usr/bin/env bash
echo "bun: command not found (stub)" >&2
exit 127
STUB
chmod +x "$stubdir/bun"
out5=$(PATH="$stubdir:$PATH" MORGEN_REPO="$MORGEN_REPO" SUPERHUMAN_REPO="$SUPERHUMAN_REPO" bash "$GATE" 2>&1)
rc5=$?
rm -rf "$stubdir"
if [ "$rc5" -ne 0 ]; then
  pass "test5: nonzero exit when bun/test runner cannot run (rc=$rc5)"
else
  fail "test5: expected nonzero exit when bun cannot run, got rc=0"
fi
if echo "$out5" | grep -qE 'PASS[[:space:]]+(morgen|superhuman) 0 fail$'; then
  fail "test5: vacuous 'PASS ... 0 fail' still present when bun never ran"
else
  pass "test5: no vacuous test-never-ran PASS output"
fi

echo ""
if [ "$fails" -eq 0 ]; then
  echo "ALL TESTS PASS"
  exit 0
else
  echo "$fails TEST(S) FAILED"
  exit 1
fi
