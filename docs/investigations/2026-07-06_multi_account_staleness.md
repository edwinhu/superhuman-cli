# Multi-Account Sync Staleness — Investigation + Fix

Date: 2026-07-06
Branch: `fix/multi-account-sync-staleness`

## Symptom

Superhuman keeps a per-account local OPFS SQLite cache (the thing `sqlite-search.ts` reads for
`inbox`, `search`, `read`, `--needs-reply`, etc). Non-active/non-visible linked accounts could have
a stale or empty cache, so CLI reads for those accounts silently returned 0 results — no error, just
looked like "no mail":

```
superhuman inbox --account ehu@law.virginia.edu       # → 0
superhuman search "is:starred" --account ehu@...       # → 0
superhuman inbox --needs-reply --account ehu@...       # → 0
```

Switching the active account in the app (`superhuman account switch 2`) triggered a sync and the
account's inbox went 0 → 60 messages within seconds. This directly breaks multi-account workflows
(e.g. a morning briefing across two accounts) that never switch the visible account.

## Root Cause

Superhuman runs one background-sync engine per **linked** account inside the Electron app's hidden
`background_page.html` — one iframe per account, each with its own DI container
(`window.background.di`). Background sync for a non-active account is **not** categorically broken:
a backgrounded account's `sync` service still polls autonomously (confirmed via live
`Network.requestWillBeSent` capture tagged by `frameId` — Gmail history polls / MS Graph
`mailFolders` calls fire for non-visible accounts too), just at a slower interval than the
foreground account.

The actual bug is narrower: **some accounts' `sync` engine is never `.start()`-ed for the lifetime
of the current Electron session.** `sync.start()` appears to be invoked on account
activation/foreground-switch, not unconditionally for every linked account at app boot. An account
linked before the last app restart, but never made active since, can sit with `sync._isStarted ===
false` indefinitely — its iframe/DI container exists and is otherwise healthy, nothing ever kicks off
its poll loop.

### Evidence (from the investigation, iterations 1-2; see `.planning/HYPOTHESES.md`)

- Live reproduction, no synthetic setup needed: `eh2889@nyu.edu`'s `sync._isStarted === false`,
  `_hasRunSyncBackendOnce === false`, `_syncForwardPollCount === 0`, while its on-disk data was
  7+ days stale (`historyIdUpdatedAt` = 2026-06-28 vs. now 2026-07-06).
- `sync.start()` source (minified, read via CDP):
  ```js
  start(){ this._isStarted || (
    this._isStarted = !0,
    this._batteryManager.onChargingChange(this._onChargingChange),
    this._syncRealtime.start(),
    this._updatePolicy()
  ) }
  ```
  A single boolean guard — idempotent, no side effects beyond kicking off the normal poll loop. Safe
  to call unconditionally, from CDP, in any account's iframe context, without switching the visible
  account.
- Verified end-to-end: called `bg.di.get("sync").start()` in the NYU iframe's execution context
  only (via `connectToBackgroundPage()`'s `contextByEmail`), left the visible page on
  `eddyhu@gmail.com` throughout (checked via `/json/list` before/after — no `Page.navigate`, no
  `switchAccount`). After ~40s: `threads` 3174→3245, `messages` 3764→3837,
  `thread_search_content` 3174→3245, `sync.historyIdUpdatedAt` jumped from 2026-06-28 to
  2026-07-06 (now).

## Freshness Marker

`MAX(threads.sort)` (== `MAX(messages.timestamp)`, both are the same underlying value) is a real
SQLite column present identically in both Gmail and Microsoft account blobs — no provider-specific
branching needed (this replaces an earlier idea of parsing Gmail's `sync.historyIdUpdatedAt` vs. MS's
different key/value shape). Caveat: this measures "is the cached mailbox as new as real mail
activity", not "is the sync engine healthy" — a quiet mailbox with no new mail will show a large gap
even with a perfectly healthy, actively-polling sync engine. A large gap should trigger a
`sync.start()` + bounded wait, not be reported as "broken" on its own.

## Awaitable Completion Signal

After calling `sync.start()`, poll `sync._pollers.syncForward._lastRunEnded` (ms epoch, updated when
a poll cycle completes) until it advances past a pre-call snapshot. Empirically detected within
~2-8s of the real completion event at a 2s poll interval (worst case bounded by the poller's own
`_interval`, observed 60000ms, so a ~90s safety timeout is used).

`consecutiveBackendErrors` (a separate counter on the `syncBackend` poller, labels/notifications
related) is a secondary/diagnostic signal only — an account can accumulate backend errors on that
poller while its mail-relevant pollers (`syncForward`/`syncInbox`) keep running fine on schedule.
`forceSyncBackend()` (`_runSyncBackend({causedByLoad:true})`) exists as an escalation lever for the
rare case of both a high error count AND a real freshness gap; wired as an opt-in (`--force`), not
the default path.

## Design / Fix

New module `src/account-sync.ts`:

- `computeFreshness(db, nowMs)` — pure SQL (`MAX(threads.sort)`, `COUNT(threads)`,
  `COUNT(messages)`) against an already-open `bun:sqlite` connection. Unit-testable against a
  fixture DB with no blob extraction needed.
- `getAccountFreshness(email, nowMs)` — wraps `computeFreshness` with the existing
  `findOPFSBlob`/`extractSQLite` blob-acquisition helpers from `sqlite-search.ts`. Returns `null`
  when no local blob exists at all for this account.
- `ensureAccountSynced(email, opts)` — `{ maxAgeMs = 15min, timeoutMs = 90s, force?, port? }`:
  1. Check `getAccountFreshness`. If `!force` and the marker's age is under `maxAgeMs`, return
     immediately (`reason: "fresh"`) without ever touching CDP.
  2. Otherwise connect to the background_page (`connectToBackgroundPage()`, reused unchanged from
     `src/background-page-refresh.ts`), look up the target account's iframe execution context,
     evaluate a snapshot expression that reads the pre-call `_pollers.syncForward._lastRunEnded`
     and then calls `sync.start()` (idempotent, safe unconditionally).
  3. If `force`, additionally best-effort-call `forceSyncBackend()` (existence-checked, wrapped in
     try/catch — ignored on failure, falls through to the normal wait).
  4. Poll `_pollers.syncForward._lastRunEnded` every `pollIntervalMs` (default 2s) until it advances
     past the pre-call snapshot, or `timeoutMs` elapses.
  5. If the poller shape can't be read at all (renamed/restructured internals — version drift),
     degrade to a fixed timed wait (`reason: "degraded-wait"`) instead of throwing or hanging.
  6. Returns `{ synced, reason, before, after, waitedMs, error? }` with `before`/`after` freshness
     snapshots for observability.
- `listSyncableAccounts()` / `syncAllAccounts()` — enumerate every account from the background_page's
  `contextByEmail` (the live Electron session's ground truth for "what's linked"), sharing one CDP
  connection across multiple accounts.

CLI: `superhuman sync [--account <email>] [--max-age <min>] [--timeout <sec>] [--force] [--check]
[--json]`. `--check` reports staleness only, no trigger. No `--account` syncs every linked account.

**Not done in this change** (kept the diff reviewable, per scope): `inbox`/`search` read paths are
NOT auto-wired to call `ensureAccountSynced` before reading. A caller (e.g. morning-briefing) should
call `superhuman sync --account <email> --json` (or `--check` first) before a local-cache read if
freshness matters. See "Follow-ups" below.

## Fragility Notes

`sync`, `_pollers`, `_lastRunEnded`, `forceSyncBackend`, `_isStarted` are minified/private Superhuman
internals — not a public API, not versioned, can be renamed or restructured by any Superhuman
release. Every CDP-side access in `account-sync.ts` is wrapped in try/catch:

- If `bg.di.get("sync")` itself disappears or throws → `reason: "error"`, structured `error` message,
  no crash.
- If only the poller shape changes (e.g. `_pollers.syncForward` renamed) → `reason: "degraded-wait"`,
  falls back to a fixed conservative wait rather than guessing at a new shape.
- `sync.start()`'s single-boolean-guard idempotency was reconfirmed via source read in iteration 2;
  calling it repeatedly/redundantly is safe by construction.

If a future Superhuman update breaks this entirely (e.g. removes `sync` from the DI registry), the
worst-case behavior is: `ensureAccountSynced` returns `reason: "error"` and the freshness-based
"stale" detection (which is a plain SQL query, not a CDP call) keeps working regardless — so
`superhuman sync --check` degrades gracefully even if the trigger side breaks.

## Follow-ups (not done this iteration, out of scope per task)

- Auto-wiring: `inbox`/`search`/`read` local-cache paths could print a one-line stderr hint
  ("local cache for X looks stale — run `superhuman sync --account X`") when a read returns 0
  threads AND `getAccountFreshness` shows a large gap. Not added in this change to keep the diff
  reviewable and avoid a CDP round-trip on the hot read path; a cheap, read-only (no CDP) freshness
  check could be added later without much cost, if desired.
- `listLocalAccounts()` (`sqlite-search.ts`) only scans `BROWSER_ROOTS`, not `DESKTOP_ROOTS` — it
  would miss a desktop-only linked account for "list every account with local data" callers
  (`contacts.ts`, `attachments.ts`). Not touched this iteration (pre-existing, out of scope); the new
  `listSyncableAccounts()` in `account-sync.ts` avoids this gap for the sync command specifically by
  enumerating background_page iframes instead of scanning the filesystem.

## Verification

- Unit tests: `src/__tests__/account-sync.test.ts` (12 tests) — `computeFreshness` against a fixture
  DB, `ensureAccountSynced` with injected freshness/CDP seams covering fresh-shortcut, no-connection,
  no-context, synced-via-poller-advance, timeout, degraded-wait, eval-throws, force-bypass, and
  never-synced-account cases.
- Live e2e (manual, run once against the real app on CDP port 9252):
  - `superhuman sync --check` correctly reported real per-account freshness for all 3 linked accounts.
  - `superhuman sync --account eh2889@nyu.edu --max-age 1 --timeout 60` correctly detected staleness
    vs. a forced 1-minute threshold, triggered `sync.start()`, and observed the `syncForward` poller
    complete a cycle in 8.0s — `reason: "synced"`.
  - `superhuman sync --account eddyhu@gmail.com --json` correctly short-circuited (`reason: "fresh"`)
    without any CDP connection.
