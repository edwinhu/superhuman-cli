# Investigation: CLI-created drafts won't send from the Android app

**Date:** 2026-06-10
**Symptom:** Drafts created by superhuman-cli sync to all devices and open fine
in the Superhuman Android app, but the mobile app cannot send them. Drafts
created in the desktop/web app send from mobile without issue.

## Method

1. Dumped all backend-stored drafts via `userdata.getThreads {filter:{type:"draft"}}`
   and compared CLI-written values against app-written ones.
2. Extracted the official client's draft serialization from the production JS
   bundle (`daecfd7d69ddae4c0efb.background.js` / `.page.js`):
   `DraftModel.json()`, `DraftModel.fingerprint()`, `DraftId.newId()`,
   `ContactModel.format()/_escapeRfc822Name()/parseContactString()`, and the
   backend write transform `_appToBackendDraft`.
3. Located the app's own *programmatic* reply-draft construction (the AI-agent
   path, the closest analog to the CLI) at page.js offset ~6375301.

## Root causes (CLI draft value vs. official clients)

1. **Reply drafts were missing the `inReplyTo` field** (provider message id of
   the message being replied to — Gmail hex id / MS item id). The app always
   writes it (`inReplyTo: this.inReplyTo || void 0`); clients build
   `outgoing_message.in_reply_to` from it at send time. Without it, a client
   sending the draft either refuses or the backend queue-accepts and silently
   never delivers (the same failure mode documented for the CLI's own sends in
   2026-06-05_draft-send-false-success.md). The CLI kept this id only in its
   *local* draft-meta cache, invisible to other devices.

2. **Compose/forward drafts reused the draft id as the thread id.** The app
   calls `DraftId.newId()` twice — captured app drafts always have
   `threadId !== id` (see 2026-02-05_superhuman-drafts-api.md sync capture).

3. **Fingerprint format mismatch.** App: `{to: bareEmails.join(""), cc: …,
   attachments: sortedUuids.join("")}`. CLI wrote full `"Name <email>"` strings
   joined with commas — a shape no official client produces.

4. **Display names never RFC822-quoted.** The app's `_escapeRfc822Name` quotes
   any name with chars outside `/^[a-z0-9$%&'*+.\-/=?^_`{}|~ ]*$/i` (e.g.
   `"Last, First" <a@b>`); the CLI wrote them bare, which mis-parses as two
   recipients.

(1) is the likely Android blocker for replies; (2) for compose drafts. (3)/(4)
are correctness/parity fixes.

## Fix (this commit)

- `draft-api.ts`: `DraftOptions.inReplyTo` → written into the draft value
  (omitted, not null, when absent — matching the app); compose/forward drafts
  get a separately-generated draft-format thread id; fingerprint now matches
  `DraftModel.fingerprint()`; snippet length 100→200 (app parity).
- `cli.ts`: reply/reply-all pass `inReplyTo: threadInfo.gmailMessageId` (real
  provider message id only — never the conversation-id fallback) at draft
  creation; `canonicalizeRecipientLists` quotes display names via the app's
  `_escapeRfc822Name` rules; `parseRecipientStr` strips/unescapes quoted names
  so send payloads round-trip cleanly.

## Verification

- `bun test`: 356 pass (one fingerprint assertion updated to the app format).
- Compose draft → stored value verified byte-shape-identical to app drafts
  (distinct threadId, bare-email fingerprint, no spurious fields).
- Reply draft on a self-thread → stored value carries
  `inReplyTo: <gmail message id>`, `inReplyToRfc822Id`, `references`.
- Both drafts sent via `draft send --delay 0` and **verified in the Gmail Sent
  folder** (ground truth); the reply threaded into the original conversation.

## Android verification (manual, for the user)

Two fresh self-addressed test drafts were left in eddyhu@gmail.com:
- `draft00282b60ca4ff2dc` — compose, subject "Android test: send me from your phone (compose)"
- `draft00de457a2c96433c` — reply on thread 19e747cd98c910a0 ("Draft op-ed: the SEC filer-status proposal")

Open each in the Android app and hit send; both are addressed only to
eddyhu@gmail.com. If they send and land in Sent, the fix is confirmed.

## Open items

- `forward` drafts are created as standalone new threads (no `inReplyTo`,
  intentionally — adding a message id pointing outside the draft's own thread
  could confuse clients). If forwards also fail on mobile, revisit by putting
  the forward draft on the original thread like the app does.
- Mobile failure-mode details (error message vs. silent) were never observed
  directly; if the Android test still fails, capture what the app shows.
