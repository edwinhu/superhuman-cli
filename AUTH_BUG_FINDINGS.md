# Superhuman CLI — recurring auth-failure root cause (from debug session a9559a76)

## Symptom
Intermittent `401 invalid-id-token` on WRITE/AI paths (`draft create`, `send`, `reply-all`, `ai`)
while READ paths (`inbox`, `search`, `draft list`) keep working. Recovers on its own.
Confirmed live 2026-05-29: `inbox` succeeded at the same moment `reply-all` returned 401.

## Root cause — VERIFIED 2026-05-29 against source (corrections below)
- CLI stores credentials in **`~/.config/superhuman-cli/tokens.json`** (override:
  `$SUPERHUMAN_CLI_CONFIG_DIR`). Path/loader: `src/token-api.ts` `getTokensFile()` /
  `loadTokensFromDisk()` / `saveTokensToDisk()`. Format: `{version:1, accounts:{<email>:{...}}}`.
  The bearer used for write/AI calls lives at `accounts[email].superhumanToken.token`
  (mirrored into in-memory `TokenInfo.idToken` / `superhumanToken.token`).
- **CORRECTION to the original diagnosis:** the stored token is **NOT** a Firebase
  *securetoken* JWT, and there is **NO refresh token stored at all**:
  - Google accounts: the bearer is the raw **Google Sign-In ID token**
    (`iss: https://accounts.google.com`, `aud: …apps.googleusercontent.com`).
  - Microsoft accounts: the raw **Azure AD v2 ID token**
    (`iss: https://login.microsoftonline.com/<tenant>/v2.0`).
  - `accounts[email].refreshToken` is **absent/empty** for every account.
  - There is **no Firebase API key** anywhere in the repo for a token-refresh flow.
  - ⇒ The originally-proposed fix (refresh-token grant against
    `securetoken.googleapis.com/v1/token` + a Firebase API key) is **inapplicable** —
    we have neither a securetoken token nor a refresh token nor that API key.
- **TTL ≈ 1 hour — CONFIRMED.** Google ID token `exp-iat = 60 min`; MS = 65 min.
  Observed live tokens were ~48 min past expiry while reads still worked.
- **Read-vs-write auth split — CONFIRMED.**
  - Reads (`read`, `inbox list`, `search`) use the **local SQLite OPFS blob**
    (`src/sqlite-search.ts`) — no id-token needed → unaffected by token expiry.
  - Writes/AI call the Superhuman cloud backend (`https://mail.superhuman.com/~backend`)
    with `Authorization: Bearer <id-token>`. Header built inline at each `fetch()`
    in `src/draft-api.ts` (writes/send/attachments) and `src/token-api.ts`
    (`askAISearch` → `/v3/ai.askAIProxy`). Once the id-token is >1h old the backend
    returns `{"code":401,"detail":"invalid-id-token"}`.
- **The actual gap.** A refresh-on-401 helper already existed (`superhumanFetch()` in
  `token-api.ts`, used by snooze/reminders), but the **draft/send/attachment write paths
  and `askAISearch` used raw `fetch()` with no retry**. Proactive refresh in
  `getCachedToken()` (5-min `exp` buffer) exists but (a) is best-effort and (b) depends on
  the desktop app being reachable over CDP; when it returns a stale token, the write 401s
  with no recovery → "recovers on its own" only once the app later hands out a fresh token.

## The only available refresh mechanism
There is no offline refresh path (no refresh token, and CLAUDE.md forbids juggling
provider OAuth). Refresh = call the **Superhuman desktop app's**
`credential.getIDTokenAsync()` over CDP. Implemented as `refreshTokenViaCDP(email)`
(`src/token-api.ts`), preferring the silent `background_page.html` iframe path
(`src/background-page-refresh.ts`). **Requires the desktop app running with
`--remote-debugging-port`** (the app's CDP target; on this machine port **9252**, while the
default `CDP_PORT` 9250 is the browser-extension service worker).

## Fix implemented (2026-05-29)
Routed every write/AI backend call through a refresh-on-401 wrapper that reuses the
existing CDP refresh:
- `src/draft-api.ts`: new `backendFetchWithRetry(url, init, userInfo)` — on 401/403 it
  calls `refreshTokenViaCDP(userInfo.email)`, mutates `userInfo.token` in place, and
  retries once. Applied to all 7 backend write/upload/send sites (draft create/update/delete,
  attachment upload + metadata, `messages/send`).
- `src/token-api.ts`: `askAISearch()` now refreshes once via `refreshTokenViaCDP(email)`
  and retries on 401/403 (callers already pass `email`).
- `src/snooze.ts`: the 3 `superhumanFetch()` write calls now pass `token.email` so the
  pre-existing retry actually fires.
Proactive refresh (within ~5 min of `exp`) is already handled by `getCachedToken()`.

## Verification
- `bun build --compile` succeeds; touched files add no new type errors.
- `bun test` (ai-search, send-draft, draft-native, update/delete, attachment-e2e,
  token-persistence, no-provider-apis): all pass (the 6 attachment-e2e tests are live and
  require `CDP_PORT=9252`).
- Live before/after with a tampered cached id-token (corrupt signature, `expires` pushed to
  the future to skip proactive refresh):
  - BEFORE (CDP unreachable): `✗ API error 401: {"code":401,"detail":"invalid-id-token"}`
  - AFTER  (CDP @ 9252): `✓ Draft created` and the persisted token rotated to a fresh value.
