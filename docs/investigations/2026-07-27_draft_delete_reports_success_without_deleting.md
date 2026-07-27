# `draft delete` reports ✓ but does not delete (2026-07-27)

## Report

`superhuman draft delete draft005c92f1117aa74e --account eddyhu@gmail.com` (v0.38.5) printed

```
ℹ Deleting native draft 05c92f1117aa74e...
✓ Deleted native draft 05c92f1117aa74e
```

and exited 0, but the draft kept coming back from `draft list --json` 30+ seconds later.
Repeated on three ids, six ✓ messages, never converged. Deleting the same drafts from
the desktop UI worked.

## Findings

**The `draft00` → `05c92…` in the log is cosmetic, not ID mangling.** `cli.ts` logs
`draftId.slice(-15)`; the full id is what gets written. Not the bug.

**The tombstone write itself was correct.** Dumping `userdata.getThreads`
(`filter:{type:"draft"}`) for the affected thread shows the CLI's tombstones in exactly
the shape the app produces — `discardedAt` at the message level, sibling to `draft`:

```json
{"mid":"draft005c92f1117aa74e","topDiscarded":"2026-07-27T23:16:09.876000000Z","hasDraft":true,
 "keys":["discardedAt","attachments","draft","mentions","historyId"]}
```

**Why it looked like nothing happened:** `getThreads` keeps returning tombstoned messages
for as long as the thread stays in the draft index (indefinitely when a sibling live draft
holds it there), and v0.38.5's `parseThreadList` ignored `discardedAt`. Fixed at HEAD by
#37 (2026-07-22) — the installed 0.38.5 binary predates it. So the user's immediate symptom
is a stale install, released here as 0.38.6.

**But three real defects made this class of failure silent, and they are fixed here:**

1. **A 200 from `userdata.writeMessage` proves nothing.** The backend accepts a write to a
   path that matches no draft and still answers 200. Every delete reported success purely
   on the status code, so *any* wrong-path delete was invisible.
2. **`deleteDraftViaProvider` passed the draft id AS the thread id**
   (`deleteDraftWithUserInfo(userInfo, draftId, draftId)`), writing to
   `users/{u}/threads/{draftId}/messages/{draftId}/discardedAt` — a path that does not
   exist. Combined with (1), provider-id deletes were a guaranteed silent no-op.
3. **`cmdDeleteDraft` never exited non-zero.** Every failure branch — including
   "Native draft X not found" — printed an error and returned 0.

Also: the native path looked up the threadId through `listDrafts()`, which covers only the
first page (50) and now hides tombstoned drafts, so deletes of drafts further down the list
reported a spurious "not found".

## Fix

- `findDraftMessage(userInfo, draftId)` (draft-api.ts) — pages the draft index and returns
  `{threadId, discardedAt, draft}`. Callers resolve the owning thread instead of guessing it.
- `verifyDraftDiscarded(...)` — reads the tombstone back (absent from the index, or
  `discardedAt` set = deleted). Read-after-write was immediate against the live backend;
  the retries are slack for eventual consistency.
- `deleteDraftWithUserInfo` verifies before resolving and throws otherwise; the local
  send-cache entry is only evicted on a confirmed delete. `{verify:false}` for the
  post-send cleanup calls, where the draft is expected to vanish anyway.
- `cmdDeleteDraft` counts failures across all three branches (Outlook / native / provider)
  and `process.exit(1)`s; already-tombstoned drafts report "was already deleted".

## Live verification (eddyhu@gmail.com, throwaway drafts only)

| step | result |
|---|---|
| `draft create … --subject delete-test` → `draft00f6003231a7bb79` | in `draft list --json` |
| `draft delete draft00f6003231a7bb79` | ✓, exit 0 |
| `draft list --json` 3s later | **absent** |
| raw `getThreads` draft index, 6 polls over 9s | **absent** |
| `draft delete draft00deadbeefdeadbe` (bogus) | ✗ "not found", **exit 1** |

The user's live drafts (`draft0065ab5d496b15a7` et al.) were not touched.
