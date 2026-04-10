# Debug Hypotheses

## Bug: `superhuman read <thread-id>` returns 400 Bad Request for ALL thread IDs (Exchange/Outlook accounts)
Started: 2026-04-09
Status: FIXED

### Symptoms
- `superhuman read` fails with: 'Superhuman API error: 400 Bad Request — {"code":400}'
- `superhuman mark read` fails with: 'Undefined method threadInternal modifyLabels'
- `superhuman inbox` and `superhuman ai` work fine via portal
- Port 9250 has Chrome with Superhuman tab (mail.superhuman.com/ehu@law.virginia.edu — Exchange account)

### Prior Knowledge (from user's investigation)
1. `readThreadPortal` calls `portalInvoke('threadInternal', 'getAsync')` — but **getAsync does NOT exist**
2. `readThreadBackend` uses `filter: { listId: 'INBOX' }` — but **backend does NOT support listId filters → 400**
3. `threadInternal.listAsync` DOES work and can find threads by message ID match
4. A partial fix was attempted (use listAsync fallback in readThreadPortal) but returned empty []
5. Debug script confirmed listAsync match works for finding specific threads

### Key Files
- `src/read.ts` — main read implementation (FIXED)
- `src/inbox.ts` — uses `threadInternal.listAsync` successfully (reference implementation)
- `src/superhuman-provider.ts` — provider with portalInvoke/backendFetch
- `src/portal-rpc.ts` — portal RPC implementation

## Hypothesis Log

| # | Hypothesis | Test | Result |
|---|-----------|------|--------|
| H1 | readThreadPortal can be fixed by replacing getAsync with listAsync + message ID matching. IDs from inbox are message IDs (latest.id). | Code analysis of parsePortalListResult + debug-read-id2.ts confirms m.id matching | CONFIRMED + FIXED |

## Fix Applied

### readThreadPortal (src/read.ts)
- Replaced `portalInvoke("threadInternal", "getAsync", [threadId, { format: "full" }])` 
- With `portalInvoke("threadInternal", "listAsync", ["INBOX", { limit: 200, query: "" }])`
- Iterates returned threads, matches by `json.id === threadId` OR `messages.some(m => m.id === threadId)`
- IDs from inbox are message IDs (latest.id from parsePortalListResult) — message ID matching is the primary path

### readThreadBackend (src/read.ts)
- Removed `filter: { listId: "INBOX" }` — backend returns 400 for listId filters
- Replaced with `filter: {}` (no filter)

### Regression test
- `src/__tests__/read-backend.test.ts` — fully rewritten
- "REGRESSION: portal path uses listAsync not getAsync" — verifies method is listAsync, not getAsync
- "REGRESSION: backend path does not send listId filter" — verifies filter.listId is undefined
- 14 tests total, all passing
