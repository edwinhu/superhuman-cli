# `attachment download` 401s while the app is live (Chrome-extension deployment)

**Date:** 2026-07-16
**Status:** Fixed — verified live (Brad Katsuyama / IEX "SEC Rule 611 Proposal" PDF downloaded, 452 KB, valid PDF 1.6)

## Symptom

`superhuman attachment download` for `ehu@law.virginia.edu` (Microsoft) failed with:

```
MS Graph API error 401: InvalidAuthenticationToken "Lifetime validation failed, the token is expired."
```

…while the Superhuman web app was open and live (mail.superhuman.com in Chromium, CDP :9222) and
every other CLI command — `search`, `read`, `inbox`, `account list`, `sync --check` — worked. Only
`attachment download` 401'd. A manual `superhuman account auth` fixed it, until the token aged out
again (~1 h).

## Root cause

**The CLI's on-demand token refresh has no working path on a Chrome-extension deployment, so
`getCachedToken()` silently returned an expired token.**

Chain of evidence:

1. `tokens.json` held tokens **~17.5 hours stale** for both accounts (`expires` ≈ −1056 min), and
   there is no `refreshToken` for either (confirming `AUTH_BUG_FINDINGS.md`).
2. The other commands don't notice, because they never use a live token:
   `read`/`inbox`/`search` read the local SQLite OPFS blob, and `account list` / `sync --check`
   are on-disk enumerations. `attachment download` is the one read path that must hit a live API,
   so it is the first to surface the staleness. **It was never an attachment bug** — it was the
   only honest witness to a broken refresh.
3. `getCachedToken()` does try to refresh (`refreshTokenViaCDP`, 5-min expiry buffer), but every
   branch of `refreshTokenViaCDP` assumed the **Electron desktop app**:
   - `refreshOneViaBackgroundPage()` needs a `background_page.html` page target — Electron-only.
     This machine (Linux) runs the **Chrome extension**; no such target exists.
   - the legacy `switchAccount → Page.navigate` fallback is disabled by default (focus-steal fix).
   On failure `refreshTokenViaCDP` returns `undefined`, and `getCachedToken` deliberately falls
   back to the stale token (`refreshed ?? token`) — so the expired token flowed straight to MS
   Graph and 401'd, with no error path pointing at auth.
4. The extension's own CDP targets are **unusable for scripting**: the service worker
   (`…/background/background_page.js`) and the offscreen document
   (`…/offscreen/offscreen_page.html`) never answer `Runtime.evaluate` — not even `1+1`, and not
   even `Runtime.enable` (verified via direct target attach and browser-level
   `Target.attachToTarget`). Page targets on the same port respond fine, so this is a Chromium
   restriction on debugging extension contexts, not a dead port. **Any future fix that depends on
   evaluating JS in the extension's SW/offscreen context will hang** — including the `cmdAuth`
   Chrome path (`extractTokenChrome`), which is why manual re-auth is unreliable here too.

## Fix

New `src/session-refresh.ts` → `refreshViaSessionCookies(email)`, wired into `refreshTokenViaCDP()`
between the Electron iframe path and the auto-heal path, so **every** command benefits (not just
attachments).

It reproduces what the app's own `Credential.refreshSession()` does (reverse-engineered from
`background/background_page.js` in the extension bundle):

```
GET  https://accounts.superhuman.com/~backend/v3/sessions.getCsrfToken   → { csrfToken, expiresIn }
POST https://accounts.superhuman.com/~backend/v3/sessions.getTokens
     headers: { "X-CSRF-Token": <csrfToken> }
     body:    { emailAddress, googleId }
     → { authData: { idToken, accessToken, expires, … }, aliases, calendars }
```

Both are cookie-authenticated. The CLI reads Superhuman's session cookies out of the live browser
via CDP `Network.getCookies` **on a page target** (page targets respond; extension targets don't),
then talks plain HTTPS to Superhuman's backend. No JS evaluation in extension contexts, no
navigation, no focus steal, and no provider OAuth flow — Superhuman's backend mints the provider
token. The session cookies long outlive the 1-hour tokens, so **no interactive re-auth**.

Verified provider-agnostic: `eddyhu@gmail.com` → `ya29.…` (opaque, 60 min), `ehu@law.virginia.edu`
→ Graph JWT (`aud: https://graph.microsoft.com`, correct `upn`, 67.8 min).

## Why the byte-fetch still uses MS Graph / Gmail

The directive for this work was to fetch the attachment **bytes** from the Superhuman backend and
remove the `graph.microsoft.com` call entirely. **That is not possible for received mail**, and the
evidence is Superhuman's own code. From `AttachmentDataLoader._getDataFromRemoteSourceAsync`
(deobfuscated):

```js
_getDataFromRemoteSourceAsync(e, t) {
  const r = this._attachment.getSource();
  if ("gmail" === r.type)     return e.get("isMicrosoft") ? null : this._getDataFromGmailAsync({source: r, di: e, context: t});
  if ("microsoft" === r.type) return e.get("isMicrosoft") ? this._getDataFromMicrosoftAsync(r, e) : null;
  if ("upload-firebase" === r.type) { if (r.url) return e.get("backend").downloadAttachmentAsync(r.url); … }
  throw new Error(`tried to get data from unsupported attachment type: ${r.type}`);
}
```

- `microsoft` source → `di.get("msgraph").downloadAttachment(…)`, which is literally
  `GET https://graph.microsoft.com/v1.0/me/messages/{id}/attachments/{id}/$value`.
- `gmail` source → `GET https://content.googleapis.com/gmail/v1/users/me/messages/{id}/attachments/{id}`.
- `backend.downloadAttachmentAsync(url)` — the only Superhuman-served path — fires **solely** for
  `upload-firebase` sources, i.e. attachments *we uploaded* to a draft. Received attachments never
  have that source type.

The only other Superhuman-side copy is `attachmentInternal`, a **local CacheStorage**
(`{name: "attachment", version: 2}`, keys `https://cache/~attachments/<id>`) — a client-side cache
populated *after* a provider download, not a server the CLI can query, and only populated for
attachments already opened in the app.

So the app itself calls the provider directly for received attachments; there is no backend proxy
to route through. This confirms the exception already recorded in CLAUDE.md. What the fix *does*
achieve is the substance of the directive: **the credential now comes from the Superhuman backend**
(`sessions.getTokens`) rather than a stale cached OAuth token, so there is no per-account OAuth
flow and no re-auth. The provider call is only the byte transport, using a Superhuman-minted token
— exactly what the app does.

## Follow-up sweep: every refresh entry point, both deployments

`refreshTokenViaCDP` was only one of four. Swept the rest; all now try Electron first, then the
session-cookie path:

| Entry point | Was | Now |
| --- | --- | --- |
| `refreshTokenViaCDP()` (via `getCachedToken`/`resolveToken`) | Electron-only → stale token | Electron → session cookies |
| `refreshAllTokens()` (bulk) | Electron-only → `null` on web | Electron → session cookies (one cookie read + one CSRF for all accounts) |
| `account auth` (`cmdAuth`) | Electron → **SW path (hung forever)** → nav | session cookies first (0.44s) → SW (now bounded) → nav |
| `doctor` | Electron-only signal → "UNHEALTHY", advised relaunching an app Linux doesn't have | healthy if **either** path works; names the working one |

Two live bugs surfaced by the sweep, both fixed:

1. **`superhuman account auth` hung forever** — the manual workaround the user had been relying on.
   `extractTokenChrome()` evaluates JS in the extension's service worker with **no timeout**; an
   idle-stopped MV3 worker still lists in `CDP.List()` and still accepts a websocket, but never
   answers. All SW evaluates are now bounded (`swEvaluateWithTimeout`, 5s) so failure falls through
   instead of hanging. Verified: hang → **0.44s**, both accounts refreshed.
2. **`doctor` misreported a healthy machine as UNHEALTHY** (exit 1) and told the user to run
   `--fix`, which relaunches `Superhuman.app` — meaningless on Linux. Now: `✓ Token refresh:
   healthy — silent refresh works via Superhuman session cookies (backend)`, exit 0.

Note this contradicts commit 76ebd73 ("sync works on Chrome-extension deployments (service worker
path)"), which reported the SW path verified live. It works only while the worker happens to be
awake; right now `sync --check` silently falls back to on-disk enumeration ("app not reachable over
CDP"). Anything depending on evaluating JS in an extension context is inherently flaky for this
reason — `sync`'s `extensionSession` still has this weakness (it is at least bounded by its own
connect timeout, and degrades to a correct on-disk answer rather than a wrong one, so it is left
as-is here).

Electron benefits too: when its debug port tears down mid-session (the known 9252 teardown), the
session-cookie path is now a silent recovery *before* the focus-stealing nav fallback.

## Verification

- `bunx tsc --noEmit` clean; `bun test` → 435 pass / 0 fail (+3 new `session-refresh` tests).
- Live repro with the 17.5-h-stale `tokens.json` still on disk, no re-auth:
  - BEFORE: `✗ Failed to download: MS Graph API error 401 … token is expired`
  - AFTER:  `✓ Downloaded: ~/Downloads/rule611-inbound/brad_rule611.pdf (451.9 KB)`
  - `file` → `PDF document, version 1.6`; `pdftotext` → "SEC Rule 611 Proposal – Issues &
    Potential Analysis".
  - `tokens.json` rotated in place: `ehu@law.virginia.edu` `expires` −1041 min → **+63.7 min**.
