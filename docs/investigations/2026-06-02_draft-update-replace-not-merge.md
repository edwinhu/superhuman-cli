# `draft update` was a full REPLACE, not a merge (blanked To/Subject)

> **FIXED 2026-06-02.** `draft update --body` now preserves To/Subject/CC/BCC/
> references/threading. Verified live + regression tests added.

**Date:** 2026-06-02
**Account:** eddyhu@gmail.com (Gmail)

## Symptom
`superhuman draft update <id> --body "y"` (body only) silently reset the draft's
`to` to `[]` and `subject` to `""`, while keeping `threadId` — so it still
threaded and the breakage was easy to miss until you noticed the recipient and
subject were gone. Reproduced: `reply` → draft correctly carries
`to:["help@sleep.me"]`, `subject:"Re: …Leak"`; a follow-up body-only
`draft update` blanked both.

## Root cause
`updateDraftWithUserInfo` (`src/draft-api.ts`) built a **complete** draft value
object and wrote it to `users/{u}/threads/{t}/messages/{d}/draft` via
`userdata.writeMessage`. That endpoint **replaces the entire value** at the path.
Because the function used `options.X || default` for every field, anything the
caller didn't pass collapsed to a default:

```
to:      formatRecipients(options.to)   // undefined -> []
cc/bcc:  formatRecipients(...)          // undefined -> []
subject: options.subject || ""          // undefined -> ""
references: []                          // always wiped
rfc822Id:  generateRfc822Id()           // regenerated every edit (message-id churn)
inReplyToRfc822Id: options.… || null    // threading parent wiped if not re-passed
```

The CLI already passed `undefined` for unspecified flags (`cli.ts` `cmdDraft`),
so the blanking was **server-payload side**, not a CLI argument problem — the
update simply had no notion of "leave this field alone."

A second, latent bug: `SuperhumanDraftProvider.updateDraft` did a partial merge
that set `body: updates.preview || existingDraft.preview` — i.e. it would
overwrite the real body with the **100-char snippet** (`preview`). Not on the
active CLI path (the CLI calls `updateDraftWithUserInfo` directly), but wrong.

## Fix
**Merge instead of replace.** `updateDraftWithUserInfo` now:
1. Fetches the current draft via `userdata.getThreads` (`fetchDraftValue`) — the
   backend returns the full draft object in the same shape `writeMessage` wrote
   (`to:["help@sleep.me"]`, `fingerprint`, `inReplyToRfc822Id`, `rfc822Id`, …).
2. Uses it as the base (`...existing`) and overrides **only** fields explicitly
   present in `DraftOptions` (`options.X !== undefined ? … : existing.X`).
3. Preserves `rfc822Id` (no more churn), `references`, `inReplyToRfc822Id`,
   `labelIds`, `clientCreatedAt`, and any unmanaged fields (`autoDraftKind`, …);
   recomputes `snippet` from the new body and keeps `fingerprint` in sync with To.
4. If the draft genuinely can't be read (see "Review hardening" below), it
   **refuses to write** rather than overwriting with blanks.

`SuperhumanDraftProvider.updateDraft` was simplified to forward only changed
fields (and never send `preview` as the body) — the low-level function does the
merge now.

### Gotcha found during implementation
`userdata.getThreads` rejects `limit > 100` with **HTTP 400**. The merge read
pages in 100s (see "Review hardening").

## Verification (live, eddyhu@gmail.com)
| Action | Result |
|---|---|
| `reply` then `draft update --body` | To `["Dawn R <help@sleep.me>"]`, Subject, `inReplyToRfc822Id` all **preserved**; body updated; `rfc822Id` unchanged |
| `draft update --subject` | Subject changed; **body + To preserved** |
| `draft update --to` | To changed + fingerprint updated; **Subject + body preserved** |

Test drafts created during verification were deleted afterward.

## Tests
- `src/__tests__/draft-update-merge.test.ts` (new, 5 cases): body-only / subject-
  only / to-only merges, unmanaged-field carry-forward, and the no-existing-draft
  fallback.
- `src/__tests__/superhuman-draft-update-delete.test.ts` (updated): its mock was
  rewritten to model the draft as mutable server state (the old mock hard-coded a
  6-call sequence and broke once the merge added its `getThreads` read — that read
  is correct and required).

## Files changed
- `src/draft-api.ts` — `fetchDraftValue` + merge rewrite of `updateDraftWithUserInfo`
- `src/providers/superhuman-draft-provider.ts` — `updateDraft` forwards only changed fields

## Review hardening (post code-review, 2026-06-02)
- **No silent re-blanking when the draft can't be read.** `fetchDraftValue` now
  pages through drafts with `offset` (100/page, up to 1000) instead of a single
  capped page, so a target beyond the first 100 is still found. If it still can't
  read the draft (genuinely missing, or backend unreachable), `updateDraftWithUserInfo`
  now **throws and refuses to write** rather than overwriting with blank
  To/Subject/body. Covered by new tests (refuse-on-unreadable, page-past-100).
- `formatRecipients` hoisted to a single module-level helper (was duplicated in
  create + update).
