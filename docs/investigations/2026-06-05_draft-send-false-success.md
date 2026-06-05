# Investigation: `draft send` false-positive success + silent attachment non-delivery

**Date:** 2026-06-05
**Account affected:** `ehu@law.virginia.edu` (Microsoft / MS Graph)
**Symptom:** `draft send` of a reply-all draft carrying a `.docx` attachment printed
`✓ Draft sent!`, but the email never went out. ~10 min later Superhuman injected a
system email ("An email failed to send from Superhuman", from `meagan@superhuman.com`)
and flagged the message "Send failed".

## Root causes (two distinct bugs)

### 1. The ✓ confirms *queuing*, not *delivery* (reporting bug)

`sendDraftSuperhuman()` POSTs to `/messages/send` with `delay: 20` (the undo
window). That endpoint is Superhuman's **asynchronous scheduled-send queue** — a
`200 {send_at}` means *"accepted into the queue; will dispatch at send_at"*, not
*"delivered"*. Actual provider delivery (MS Graph `sendMail` / Gmail SMTP) happens
server-side after the undo window and can still fail; on failure Superhuman injects
the "failed to send" notice up to ~10 min later.

`cmdSendDraft` / `cmdSend` treated the `200` as terminal success and printed
`✓ Draft sent!` with **no post-send verification**. So queue-acceptance was
misreported as delivery.

Note: `send_at ≈ now + 20s` because `delay` defaults to the 20s undo window — the
"Scheduled for ≈ send moment" is *expected*, **not** a miscomputed delay. The
delay logic was never the problem.

### 2. Attachments were not carried into the send (the actual delivery failure)

Empirically isolated by self-sends on the same MS account:

| Send | Path | Result |
|------|------|--------|
| Plain (no attachment) | `draft send` | **Delivered** (arrived in inbox) |
| `.docx` attachment | `draft send` | **Failed** (10-min "failed to send" notice) |

So plain MS sends work; the attachment is what breaks delivery. Two compounding
defects:

- **`draft send <id>` dropped attachments entirely.** `DraftMeta` (draft-cache)
  had no `attachments` field, and `cmdSendDraft` called `sendDraftSuperhuman` with
  no `attachments` → `outgoing_message.attachments = []`. But the draft *did* have
  the attachment recorded server-side (uploaded + `userdata.writeMessage` metadata
  at draft-creation time). The backend reconciles the draft's stored attachment
  against the outgoing payload at delivery time; the mismatch / unresolvable blob
  makes the MS Graph send fail.

- **The send-payload attachment schema was stripped/unverified.** Even on the
  `reply --send` path (which *did* pass attachments), `sendDraftSuperhuman` emitted
  `source: { type: "upload", uuid }` — missing `cid` and `source.{thread_id,
  message_id, url}`. The send-payload schema was never ground-truthed (no e2e test,
  no captured payload had a real attachment). The project's own notes document the
  required shape as `{uuid, cid, name, type, inline, source:{type:"upload",
  thread_id, message_id, uuid, url}}`.

### 2b. The real reply-delivery blocker: `current_message_ids`

Fixing the attachment schema was necessary but **still didn't deliver** — and a
plain CLI *reply* (no attachment) didn't deliver either, while compose-style
`draft send` did. So the reply path had an independent delivery bug.

Captured a real app **reply** (driven via CDP, `r` → type → ⌘+Enter) and diffed
its `messages/send` against the CLI's:

| field | app reply | CLI reply (before) |
|------|-----------|--------------------|
| `current_message_ids` | `[itemId1, itemId2, draftId]` | `[draftId]` only |
| `in_reply_to` (top-level) | provider **item id** | rfc822 id |

`sendDraftSuperhuman` hard-coded `current_message_ids: [options.draftId]`. For a
reply the backend needs the prior thread message item-ids there to thread + send
via MS Graph; with only the draft id the send is accepted (HTTP 200) then fails
delivery — the same silent-failure signature. Also, `outgoing_message.in_reply_to`
must be the provider **item id** (the rfc822 id stays in the `In-Reply-To` MIME
header). Compose-style sends were unaffected because they have no prior messages.

Fix: `SendDraftOptions` gained `currentMessageIds` and `inReplyToItemId`;
reply/reply-all pass `[originalItemId, draftId]` + the item id (persisted in
`DraftMeta` as `replyItemIds`/`inReplyToItemId` so the two-step `reply` →
`draft send` repro works too). Confirmed end-to-end: plain reply, reply +
attachment, and `reply --attach` → `draft send` all delivered with the attachment
and no "failed to send" notice.

### 3. (Bonus, found en route) Compose `send` / `send --draft` 403 on MS accounts

`userInfoFromProvider()` (send-api.ts) built `UserInfo` with the **provider access
token** as the backend bearer (`getUserInfoFromCache(..., token.accessToken)`). For
Microsoft accounts that's an MS Graph token, which the Superhuman backend rejects
with `403`. The `draft send` path (`buildUserInfo`) correctly uses
`superhumanToken.token`. Fixed `userInfoFromProvider` to mirror that selection and
forward the `x-superhuman-user-external-id` / `device-id` headers.

## Fixes

1. **Carry attachments through `draft send`.** `DraftMeta` gained an `attachments`
   field; reply/reply-all/forward persist uploaded attachments into the cache
   (`cacheDraftAttachments`); `cmdSendDraft` reloads them and passes them to
   `sendDraftSuperhuman`.
2. **Correct outgoing attachment schema.** `SuperhumanAttachment` now carries
   `cid`, `threadId`, `messageId`, `size`; `uploadAttachmentSuperhuman` returns
   them; `sendDraftSuperhuman` emits the full `source.{thread_id, message_id, uuid,
   url}` + top-level `cid`/`size`.
3. **Honest reporting.** `draft send` no longer prints a bare `✓ Draft sent!`. It
   prints `✓ Draft queued — dispatching at <time>` plus a note that delivery
   confirms after the undo window and a failure would surface in the inbox. (Per
   the user's request, no blocking delivery-poll was added.)
4. **Fixed the MS-account 403** in `userInfoFromProvider`.

## Verification

- Unit: `src/__tests__/send-attachment-schema.test.ts` locks the outgoing
  attachment schema (intercepts `fetch`, asserts `cid` + `source.*`).
- E2E (self-send, MS account): plain `draft send` delivers; attachment `draft send`
  via the fixed path delivers with the attachment and produces no "failed to send"
  notice. (See session log 2026-06-05.)

## The real send schema (captured from a live app send)

Two wrong guesses preceded the fix, each verified-failed against the live account:
1. `source:{type:"upload", url, ...}` — wrong `type`, had a URL.
2. `source:{type:"upload-firebase", ..., attachment_id:null, fixed_part_id:"0",
   cid}` — read from the app bundle's `toJsonRequest`, but **still failed**.

The bundle *lists* `attachment_id/fixed_part_id/cid` in the source, but those are
`undefined` for a not-yet-sent upload, so `JSON.stringify` **omits** them. The
authoritative shape was captured by CDP-monitoring a real app attachment send
(driven via `DOM.setFileInputFiles` on the hidden `.Attach-file-input`, sent with
⌘+Enter) — the actual `outgoing_message.attachments[]` on the wire is:

```json
{
  "uuid": "…", "cid": "…", "name": "appcap.txt", "type": "text/plain",
  "inline": false,
  "source": { "type": "upload-firebase", "thread_id": "…",
              "message_id": "…", "uuid": "…" }
}
```

Final corrections:
- `source.type` is **`"upload-firebase"`**.
- `source` carries **only** `type, thread_id, message_id, uuid` — **no**
  `attachment_id`, `fixed_part_id`, `cid`, or `url`, and **no top-level `size`**.
  Adding `attachment_id:null` (an explicit null, unlike an omitted undefined) is
  enough to make the backend reject the reference → silent non-delivery.
- The backend resolves the blob from the `userdata.writeMessage` attachment
  metadata (which carries the firebase `url`) by joining on
  `thread_id/message_id/uuid`. That metadata write already matched the app's
  byte-for-byte, so no change was needed there.

`src/draft-api.ts:sendDraftSuperhuman()` now emits exactly this shape. Confirmed
by a positive control: app-driven attachment sends (same schema) delivered with
the attachment intact.

## Follow-ups / open

- Compose `send --attach` (top-level compose) still does not upload attachments;
  out of scope here.
