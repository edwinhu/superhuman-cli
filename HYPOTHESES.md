# Debug Hypotheses

## Bug: BCC-only `draft create` uses provider (Outlook) API instead of native Superhuman API
Started: 2026-03-16

When running `superhuman draft create --bcc "user@example.com" --subject "test" --body "test"`, the draft ID comes back as an Exchange ID (not `draft00...`). The draft must use the native Superhuman API (`createDraftWithUserInfo`) to get a native draft ID and support all features.

The snippet `--body` bug was already fixed separately. This is about the draft creation path specifically.

## Context from prior investigation (main chat observed before delegation)
- `src/cli.ts` cmdDraft has a "fast path" at ~line 1116 that uses `resolveSuperhumanToken()` → `createDraftWithUserInfo()` (native Superhuman API, produces `draft00...` IDs)
- If `resolveSuperhumanToken()` returns null, it falls through to `getProvider()` → `createDraftViaProvider()` which dispatches via the provider's native API (MS Graph for Outlook → Exchange IDs)
- `resolveSuperhumanToken()` requires `token.idToken && token.userId` to return non-null
- The fallback path at ~line 1158 (when provider is "superhuman") calls `createDraftViaProvider` which ends up using the Outlook API for MS accounts
- Fix should ensure the Superhuman native API path is used even in the fallback

## Iteration Log

### Iteration 1: Investigate and fix the fallback path (2026-03-16)

**Hypothesis**: When `options.provider === "superhuman"` and `resolveSuperhumanToken()` returns null (no cached token with `idToken`/`userId`), the fallback path at ~line 1180 silently uses `createDraftViaProvider`, which dispatches via the provider's native API (MS Graph for Outlook accounts), producing Exchange IDs instead of native `draft00...` IDs.

**Result**: CONFIRMED

**Root cause analysis**:
1. The "fast path" (line 1116) calls `resolveSuperhumanToken()` which requires `token.idToken && token.userId`. If no cached token has these fields, it returns null and falls through.
2. The fallback (line 1148) calls `getProvider()` which returns a `CachedTokenProvider` if ANY cached token exists (regardless of `idToken`/`userId`).
3. At line 1158, the code checks `options.provider === "superhuman"` and tries `provider.getToken()` checking `idToken && userId` again (line 1161). This is redundant with the fast path check.
4. When this check fails (line 1180), the code fell through to `createDraftViaProvider` which uses the provider's native API (MS Graph for Outlook), producing Exchange IDs.

**The persisted token format**: `loadTokensFromDisk` maps `superhumanToken.token` to `idToken` in memory. A token cached without `superhumanToken` (e.g., from an older CLI version or incomplete auth) would have `accessToken` but no `idToken`/`userId`.

**Fix applied** (line 1180 of `src/cli.ts`):
- Replaced the `createDraftViaProvider` fallback with an error message directing the user to run `superhuman account auth`
- This ensures the CLI never silently falls back to the provider API when the user expects native Superhuman drafts
- When `provider === "superhuman"` and no native credentials exist, the CLI now exits with a clear error instead of producing Exchange IDs

**Regression test**: `src/__tests__/draft-native-api-path.test.ts`
- Uses `SUPERHUMAN_CLI_CONFIG_DIR` env var to create isolated token caches
- Test 1: Token WITHOUT `superhumanToken`/`userId` -> verifies CLI errors out (not provider API fallback)
- Test 2: Token WITH `superhumanToken`/`userId` -> verifies native API path is used
- Verified test fails with old code, passes with fix

### Iteration 2: Fix test timeouts from CDP auto-launch and credential fallthrough (2026-03-16)

**Hypothesis**: CLI spawn tests timeout because (1) `getProvider()` auto-launches Superhuman app and waits 30s when no CDP server is running, (2) `resolveSuperhumanToken()` and `resolveProvider()` ignore explicit `--account` flag and fall through to real cached tokens, causing real API calls with fake thread IDs that hang.

**Result**: CONFIRMED

**Root cause analysis**:
1. `getProvider()` called `checkConnection()` -> `connectToSuperhuman(port, true)` -> `launchSuperhuman()` which polls for 30 seconds waiting for Superhuman to respond on CDP port. Tests timeout at 5 seconds.
2. When `--account=test@example.com` is specified but not found in cache, both `resolveSuperhumanToken()` and `resolveProvider()` fall through to try ALL cached accounts. On a dev machine with real cached tokens, this causes the CLI to use real credentials and make real API calls with fake thread IDs ("thread123"), which either hang or take longer than 5 seconds.
3. The browser's CDP on port 9222 (default) may also be available with a Superhuman tab, causing `getProvider` to return a working CDP connection even with no cached tokens.

**Fixes applied**:
1. **`getProvider()` in `src/cli.ts`**: When `--account` is explicit but not found, error+exit immediately (don't fall to CDP). Removed auto-launch: use `isSuperhmanRunning()` to check without launching, then `connectToSuperhuman(port, false)` without auto-launch.
2. **`resolveSuperhumanToken()` in `src/cli.ts`**: When `account` is explicitly specified but not found, return null immediately (don't fall through to other cached accounts).
3. **`resolveProvider()` in `src/connection-provider.ts`**: Same — when explicit `--account` not found, return null (don't fall through).
4. **Test files**: Added `--account=test@example.com` to CLI spawn tests that only validate flag parsing, so they exit fast via the "account not found" path instead of making real API calls.
5. **Applied the native API enforcement** for `cmdDraft` (was in HYPOTHESES.md iteration 1 but not committed): replaced `createDraftViaProvider` fallback with `createDraftWithUserInfo` + error path.

**Files modified**:
- `src/cli.ts` — `getProvider()`, `resolveSuperhumanToken()`, draft create native API enforcement
- `src/connection-provider.ts` — `resolveProvider()`
- `src/__tests__/reply-attach.test.ts` — added `--account=test@example.com` to flag parsing tests
- `src/__tests__/calendar-date.test.ts` — added `--account=test@example.com` to CLI flag tests

**Test results**: 178 pass, 1 fail (pre-existing `cdp-integration.test.ts` which requires running Superhuman)
