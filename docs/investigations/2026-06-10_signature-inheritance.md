# Signature Inheritance: Where Superhuman Stores Signatures + CLI Implementation

**Date:** 2026-06-10
**Outcome:** CLI sends now inherit the account's configured Superhuman signature
(send-time append, app parity). New module `src/signature.ts`; opt-out via
`--no-signature`.

## Problem

CLI-built bodies (`draft create`, `reply`, `reply-all`, `forward`, `send`)
never included the account signature. A verified sent reply contained only the
typed body — no signature block. The signature HTML was not in
`di.get('settings')._cache` (only the flags `skipSuperhumanSignature` and
`includeSignatureOnReplies` are there), so the storage location was unknown.

## Where the signature actually lives (capture-don't-guess)

Recovered from (a) the local SQLite settings mirror and (b) the app web bundle
(Service Worker CacheStorage under
`~/Library/Application Support/Superhuman/Service Worker/CacheStorage/…`,
greppable with `rg -a`). The app's resolver is `getSignature({email})`:

- **Google accounts:** the signature HTML is the `signature` field of the
  matching Gmail **sendAs alias** — synced into account settings under
  `aliases.list[].sendAs.signature`. Superhuman never edits it; its settings
  dialog links to Gmail settings ("To edit this signature, please visit Gmail
  settings"). `eddyhu@gmail.com` / `eh2889@nyu.edu` have no Gmail signature
  configured, so they correctly produce nothing.
- **Microsoft accounts:** the signature is stored as a **hidden draft** with
  `action: "signature"`. Its ids are recorded in the settings key
  `signatures: {microsoftSignatureThreadID, microsoftSignatureDraftID}` and the
  body is fetched from userdata (`userdata.getThreads` filter
  `{type:"draft"}` — the signature draft appears in the draft set even though
  it's invisible in the UI). Legacy fallback: settings key
  `microsoftSignature` (raw HTML). `ehu@law.virginia.edu` resolves to the full
  "Edwin Hu / Associate Professor of Law / …" block (4.8KB of HTML).
- **Settings source:** the full per-account settings JSON (~80KB, far more
  than the `_cache` snapshot) sits in the local SQLite mirror — `general`
  table, key `settings` (via `findOPFSBlob`/`extractSQLite`). The flags and
  alias list are read from there with no CDP and no backend call.

## When the app adds the signature (the critical semantics)

`OutgoingMessage.fromDraft → BodyContent.generateForOutgoingMessage`:

- If the draft's quoted content **is inlined** into the body
  (`quotedContentInlined: true`, i.e. a draft composed/edited in the app), the
  body already contains the signature → sent as-is.
- If **not inlined** (always true for CLI-created drafts), the client appends
  `signature.render()` at send time: compose → `<div>{body}{pixel}<br>{sig}</div>`;
  reply → `<div><div>{body}{pixel}<br>{sig}</div><br>{quoted}<br></div>`
  (signature after the typed text, before the quoted thread).
- `Signature.render()` markup:
  `<div class="gmail_signature">[<div>{content}</div>][<br>][Sent via Superhuman footer]<br></div>`
  — content omitted on replies/forwards when `includeSignatureOnReplies` is
  false; the promo footer omitted when `skipSuperhumanSignature` is true.

**Consequence:** the signature must NOT be baked into the stored draft body.
The desktop/mobile apps append it themselves when they send a CLI draft
(quotedContentInlined=false); a baked-in copy would be duplicated. The correct
fix is to mirror the app in the CLI's own send path only.

## Implementation

- `src/signature.ts`:
  - `getSignatureInfo(userInfo)` — settings from local SQLite; Gmail alias
    signature, or MS signature-draft body fetched via `userdata.getThreads`
    (fallback `microsoftSignature`). Per-process cache.
  - `renderSignatureBlock(info, {isReply})` — app-parity markup incl. both
    flags.
  - `buildSignedBody(userInfo, htmlBody, {isReply})` — single entry point:
    dedupe guard (`gmail_signature` / `sh-signature` /
    `data-signature-draft-id` already present → no-op), forward detection (the
    CLI inlines forwarded content into the body, so the signature is inserted
    BEFORE the `---------- Forwarded message ---------` header), graceful
    no-op when settings are unreadable.
- `sendDraftSuperhuman` (draft-api.ts) calls `buildSignedBody` on
  `options.htmlBody` unless `noSignature` — this covers every native send
  path: snippet `--send`, `draft send`, compose `send`, `reply`/`reply-all`/
  `forward --send` (and anything else routed through it, e.g. availability).
  Reply detection: `inReplyTo`/`inReplyToItemId`/`currentMessageIds.length>1`.
- `--no-signature` CLI flag threaded through all six call sites.

## Verification

- 15 new unit tests (`src/__tests__/signature.test.ts`); full suite 372 pass.
- Live self-send on `ehu@law.virginia.edu` (`draft create` + `draft send
  --delay 0`), then delivery verified against MS Graph **SentItems** (ground
  truth per CLAUDE.md): sent HTML contains the `gmail_signature` wrapper and
  the full UVA signature block.

## Notes / limits

- Gmail accounts with no Gmail-side signature get none — identical to the app.
- A Gmail signature set *after* auth reaches the CLI via the local settings
  mirror automatically (it syncs); no re-auth needed, but the Superhuman app
  must have synced (the OPFS blob is its local DB).
- MS signature adds one `userdata.getThreads` round-trip per send (cached
  in-process; CLI processes are one-shot).
- Signature inline images (`data:`/cid images in MS signatures) are passed
  through as-is; the app's `_convertSignatureDataUrls` upload path is not
  replicated. The UVA signature is text+links, unaffected.
