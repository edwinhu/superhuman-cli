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
#   G2 ROLE    no target that MAIN's selectors accept may be rejected by the
#              branch's, and no target main REJECTS may be accepted. Catches both
#              "I broke Mac auth" (false negative) and "I widened role so account
#              auth picks the login page" (false positive) — the two HIGHs I
#              introduced while hardening.
#
#   G3 TESTS   both suites at baseline.
#   G4 TSC     no new type errors.
#
# Exit 0 = substrate clean.
set -uo pipefail

MG=/home/eh/projects/morgen-cli/.claude/worktrees/endpoint-discovery
SH=/home/eh/projects/superhuman-cli/.claude/worktrees/endpoint-discovery
fails=0
note() { printf '  %-6s %s\n' "$1" "$2"; }

echo "── G1 drift: shared section byte-identical ──"
sed -n '/END PRODUCT BLOCK/,$p' "$MG/src/cdp-endpoint.ts" > /tmp/g1a.ts
sed -n '/END PRODUCT BLOCK/,$p' "$SH/src/cdp-endpoint.ts" > /tmp/g1b.ts
if diff -q /tmp/g1a.ts /tmp/g1b.ts >/dev/null 2>&1; then
  note PASS "identical ($(wc -l < /tmp/g1a.ts) lines)"
else
  note FAIL "DRIFTED — $(diff /tmp/g1a.ts /tmp/g1b.ts | grep -c '^[<>]') differing lines"
  fails=$((fails+1))
fi

echo "── G2 role: branch selectors vs main's, on real + impostor targets ──"
run_g2() {
  local repo="$1" name="$2"
  ( cd "$repo" && timeout 60 bun -e '
    import { classifyTarget } from "./src/cdp-endpoint";
    // [url, mustBe] — derived from what MAIN accepted, plus impostors main also rejected.
    const cases: [string, string|null][] = JSON.parse(process.env.G2_CASES!);
    let bad = 0;
    for (const [url, want] of cases) {
      const got = classifyTarget({ type: "page", url });
      if (got !== want) { console.log(`    MISMATCH ${url}\n      got=${got} want=${want}`); bad++; }
    }
    process.exit(bad === 0 ? 0 : 1);
  ' ) 2>&1
}

# morgen: main accepted morgen:// and *morgen.so*; impostors main also rejected.
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
mt=$(cd "$MG" && bunx tsc --noEmit --pretty false 2>&1 | grep -c 'error TS')
st=$(cd "$SH" && bunx tsc --noEmit --pretty false 2>&1 | grep -c 'error TS')
[ "$mt" -le 75 ] && note PASS "morgen $mt" || { note FAIL "morgen $mt > 75"; fails=$((fails+1)); }
[ "$st" -eq 0 ] && note PASS "superhuman $st" || { note FAIL "superhuman $st > 0"; fails=$((fails+1)); }

echo ""
echo "SUBSTRATE: $([ $fails -eq 0 ] && echo CLEAN || echo "DIRTY ($fails gate(s) failing)")"
exit $fails
