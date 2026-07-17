#!/usr/bin/env bash
# Mechanical substrate gates for the endpoint-discovery PRs.
#
# Every regression I shipped across four review rounds fell into two classes, and
# both are mechanically detectable. LLM auditors caught them; I did not. So the
# gate is a script, not my memory:
#
#   G1 DRIFT   the shared section of cdp-endpoint.ts must be byte-identical
#              across both repos. Six drift incidents, every one from editing one
#              file and asserting identity without running diff.
#
#   G2 ROLE    a hand-written regression-case table of real + impostor targets,
#              checked against EACH branch's OWN classifier. This is NOT a diff
#              against main's classifier — `src/cdp-endpoint.ts` has never
#              existed on main (`git show main:src/cdp-endpoint.ts` fails with
#              "exists on disk, but not in 'main'"); the file is new on this
#              branch, so there is no main baseline to differential against.
#              The case table is my own judgment call, written to catch the two
#              HIGHs I introduced while hardening ("I broke Mac auth" / false
#              negative, and "I widened role so account auth picks the login
#              page" / false positive) — treat it as a regression list, not a
#              mechanical proof of correctness against main.
#
#   G3 TESTS   both suites at baseline.
#   G4 TSC     no new type errors.
#
# Exit 0 = substrate clean.
#
# G1's and G2's inputs are two sibling repos. Resolve them robustly instead of
# hardcoding worktree paths that vanish once a branch merges or a worktree is
# removed: SH defaults to this script's own repo (git rev-parse), MG must be
# supplied via env or falls back to a documented default that is verified to
# exist below — if either resolved path, or either cdp-endpoint.ts inside it,
# is missing/unreadable, the whole run aborts loudly instead of silently
# comparing empty files.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SH="${SUPERHUMAN_REPO:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)}"
# MG gets the same git-rev-parse-based treatment SH has, not a bare hardcoded
# worktree literal. MORGEN_REPO always wins. Absent that, try candidates in
# order and take the first that actually contains the branch's source file:
#   1. the sibling morgen-cli checkout next to superhuman-cli's MAIN repo
#      (resolved via --git-common-dir, which survives running from inside a
#      worktree) — this is what will be correct once the feature branch
#      merges to morgen-cli's main and the worktree below is removed.
#   2. the feature worktree — last-resort default for local pre-merge dev;
#      documented to stop resolving once that worktree is removed, at which
#      point (1) should already be correct and callers should also just set
#      MORGEN_REPO explicitly (see cdp-substrate-gate.test.sh test3).
SH_COMMON_DIR="$(git -C "$SCRIPT_DIR" rev-parse --git-common-dir 2>/dev/null)"
SH_MAIN_REPO="$(cd "$(dirname "$SH_COMMON_DIR")" 2>/dev/null && pwd)"
MG_CANDIDATES=()
if [ -n "$SH_MAIN_REPO" ]; then
  sibling_top="$(git -C "$(dirname "$SH_MAIN_REPO")/morgen-cli" rev-parse --show-toplevel 2>/dev/null)"
  [ -n "$sibling_top" ] && MG_CANDIDATES+=("$sibling_top")
fi
MG_CANDIDATES+=("/home/eh/projects/morgen-cli/.claude/worktrees/endpoint-discovery")
MG_DEFAULT=""
for c in "${MG_CANDIDATES[@]}"; do
  if [ -f "$c/src/cdp-endpoint.ts" ]; then
    MG_DEFAULT="$c"
    break
  fi
done
MG="${MORGEN_REPO:-$MG_DEFAULT}"
fails=0
note() { printf '  %-6s %s\n' "$1" "$2"; }

# ── Precheck: both repos and both source files must exist and be readable. ──
# G1-G4 are meaningless (or, worse, vacuously green) if any of these are absent.
precheck_fail=0
for pair in "MG:$MG" "SH:$SH"; do
  label="${pair%%:*}"; dir="${pair#*:}"
  if [ -z "$dir" ]; then
    echo "FATAL: \$$label did not resolve to a path (set ${label}_REPO / SUPERHUMAN_REPO / MORGEN_REPO)" >&2
    precheck_fail=1
    continue
  fi
  if [ ! -d "$dir" ]; then
    echo "FATAL: \$$label repo dir does not exist: $dir" >&2
    precheck_fail=1
    continue
  fi
  if [ ! -f "$dir/src/cdp-endpoint.ts" ] || [ ! -r "$dir/src/cdp-endpoint.ts" ]; then
    echo "FATAL: \$$label/src/cdp-endpoint.ts is missing, not a regular file, or unreadable: $dir/src/cdp-endpoint.ts" >&2
    precheck_fail=1
  fi
  if [ ! -x "$dir" ]; then
    echo "FATAL: \$$label repo dir is not traversable (missing execute bit): $dir" >&2
    precheck_fail=1
  fi
done
if [ "$precheck_fail" -ne 0 ]; then
  echo "" >&2
  echo "SUBSTRATE: ABORTED — cannot evaluate gates without both real repos present." >&2
  exit 1
fi

echo "── G1 drift: shared section byte-identical ──"
MARKER='END PRODUCT BLOCK'
marker_fail=0
if ! grep -q "$MARKER" "$MG/src/cdp-endpoint.ts"; then
  note FAIL "marker '$MARKER' not found in $MG/src/cdp-endpoint.ts"
  marker_fail=1
fi
if ! grep -q "$MARKER" "$SH/src/cdp-endpoint.ts"; then
  note FAIL "marker '$MARKER' not found in $SH/src/cdp-endpoint.ts"
  marker_fail=1
fi
if [ "$marker_fail" -ne 0 ]; then
  fails=$((fails+1))
else
  sed -n "/${MARKER}/,\$p" "$MG/src/cdp-endpoint.ts" > /tmp/g1a.ts
  sed -n "/${MARKER}/,\$p" "$SH/src/cdp-endpoint.ts" > /tmp/g1b.ts
  if [ ! -s /tmp/g1a.ts ] || [ ! -s /tmp/g1b.ts ]; then
    note FAIL "extracted block is empty despite marker being present — refusing to diff empty files"
    fails=$((fails+1))
  elif diff -q /tmp/g1a.ts /tmp/g1b.ts >/dev/null 2>&1; then
    note PASS "identical ($(wc -l < /tmp/g1a.ts) lines)"
  else
    note FAIL "DRIFTED — $(diff /tmp/g1a.ts /tmp/g1b.ts | grep -c '^[<>]') differing lines"
    fails=$((fails+1))
  fi
fi

echo "── G2 regression cases: each branch's own classifier vs a hand-written table (NOT a diff against main — see header) ──"
run_g2() {
  local repo="$1" name="$2"
  ( cd "$repo" && timeout 60 bun -e '
    import { classifyTarget } from "./src/cdp-endpoint";
    // [url, mustBe] — hand-written expected-classification table (NOT a diff against
    // main; main has never had this file — see the G2 header comment above).
    const cases: [string, string|null][] = JSON.parse(process.env.G2_CASES!);
    let bad = 0;
    for (const [url, want] of cases) {
      const got = classifyTarget({ type: "page", url });
      if (got !== want) { console.log(`    MISMATCH ${url}\n      got=${got} want=${want}`); bad++; }
    }
    process.exit(bad === 0 ? 0 : 1);
  ' ) 2>&1
}

# morgen: expected-good hosts/schemes plus impostor hosts that must be rejected.
# (hand-written regression table, not a diff against main — see G2 header comment.)
export G2_CASES='[
  ["morgen://./app.html","electron"],
  ["file:///opt/Morgen/resources/app.html","electron"],
  ["https://web.morgen.so/","chrome"],
  ["https://web.morgen.so./calendar","chrome"],
  ["https://app.morgen.so/tasks","chrome"],
  ["https://example.com/","null"],
  ["https://morgen.so.evil.example/app.html","null"],
  ["https://evil.example/morgen/app.html","null"],
  ["chrome-extension://abc/app/app.html","null"]
]'
export G2_CASES=$(echo "$G2_CASES" | sed 's/"null"/null/g')
if run_g2 "$MG" morgen; then note PASS "morgen classifier"; else note FAIL "morgen classifier"; fails=$((fails+1)); fi

# superhuman: the REAL desktop scheme + the app page; role must stay mail.* only.
export G2_CASES='[
  ["superhuman-app://superhuman.com/background_page.html","electron"],
  ["https://mail.superhuman.com/~backend/build/background_page.html","electron"],
  ["https://mail.superhuman.com/e@x.com/inbox","chrome"],
  ["https://mail.superhuman.com./inbox","chrome"],
  ["https://superhuman.com/blog/very-long-marketing-slug","null"],
  ["https://accounts.superhuman.com/login","null"],
  ["https://evil.example/superhuman/background_page.html","null"],
  ["https://mail.superhuman.com.evil.example/inbox","null"],
  ["superhuman-app://evil.example/background_page.html","null"]
]'
export G2_CASES=$(echo "$G2_CASES" | sed 's/"null"/null/g')
if run_g2 "$SH" superhuman; then note PASS "superhuman classifier"; else note FAIL "superhuman classifier"; fails=$((fails+1)); fi

echo "── G3 tests at baseline ──"
m=$(cd "$MG" && bun test 2>&1 | grep -oE '[0-9]+ fail' | head -1)
s=$(cd "$SH" && bun test 2>&1 | grep -oE '[0-9]+ fail' | head -1)
[ "$m" = "0 fail" ] && note PASS "morgen $m" || { note FAIL "morgen $m"; fails=$((fails+1)); }
[ "$s" = "0 fail" ] && note PASS "superhuman $s" || { note FAIL "superhuman $s (run: account auth — E2E needs fresh tokens)"; fails=$((fails+1)); }

echo "── G4 tsc vs baseline (morgen 75, superhuman 0) ──"
# `grep -c 'error TS'` alone is vacuous: a missing/broken bunx or tsc install
# produces no matching lines, and 0 -le 75 / 0 -eq 0 both pass without tsc
# ever having run. Require a POSITIVE signal first — `tsc --version` prints
# a recognizable "Version X.Y.Z" line iff tsc actually executed — before
# trusting the error count from the real run.
tsc_ran() {
  local repo="$1" ver
  ver=$(cd "$repo" && bunx tsc --version 2>&1)
  [[ "$ver" =~ Version[[:space:]][0-9]+\.[0-9]+\.[0-9]+ ]]
}
if tsc_ran "$MG"; then
  mt=$(cd "$MG" && bunx tsc --noEmit --pretty false 2>&1 | grep -c 'error TS')
  [ "$mt" -le 75 ] && note PASS "morgen $mt" || { note FAIL "morgen $mt > 75"; fails=$((fails+1)); }
else
  note FAIL "morgen tsc did not run (bunx/tsc unavailable — 'tsc --version' produced no recognizable output)"
  fails=$((fails+1))
fi
if tsc_ran "$SH"; then
  st=$(cd "$SH" && bunx tsc --noEmit --pretty false 2>&1 | grep -c 'error TS')
  [ "$st" -eq 0 ] && note PASS "superhuman $st" || { note FAIL "superhuman $st > 0"; fails=$((fails+1)); }
else
  note FAIL "superhuman tsc did not run (bunx/tsc unavailable — 'tsc --version' produced no recognizable output)"
  fails=$((fails+1))
fi

echo ""
echo "SUBSTRATE: $([ $fails -eq 0 ] && echo CLEAN || echo "DIRTY ($fails gate(s) failing)")"
exit $fails
