# Spec: SQLite-First Data Path for read, inbox list, and mark read

> **For Claude:** After writing this spec, discover and read the explore phase skill via cache lookup for `skills/dev-explore/SKILL.md`.

## Problem

`superhuman read`, `superhuman inbox`, and `superhuman mark read` currently rely on network calls (portal RPC or backend API) that are fragile:

- **read**: Portal path called `threadInternal.getAsync` (doesn't exist → error). Backend path used `filter: { listId: "INBOX" }` (unsupported → 400). Just fixed to use `listAsync` but still fetches up to 200 inbox threads to find one by ID — slow and misses archived/non-inbox threads.
- **inbox list**: Uses portal RPC `threadInternal.listAsync` which requires a live portal connection. Falls back to backend API which doesn't support inbox filters.
- **mark read**: Uses portal RPC `threadInternal.modifyLabels` which fails with "Undefined method" on some accounts.

Meanwhile, `superhuman search` already reads directly from Superhuman's local SQLite database (OPFS blob) via `src/sqlite-search.ts` — fast, reliable, no network needed. The Superhuman app is always running so the local DB stays fresh.

## Requirements

| ID | Requirement | Scope |
|----|-------------|-------|
| READ-01 | `read` uses local SQLite as primary path to look up thread by ID | v1 |
| READ-02 | `read` falls back to portal RPC / backend API when SQLite lookup fails | v1 |
| LIST-01 | `inbox list` uses local SQLite as primary path | v1 |
| LIST-02 | `inbox list` falls back to portal RPC / backend API when SQLite fails | v1 |
| MARK-01 | `mark read` / `mark unread` works reliably — use backend API (`userdata.writeMessage` or similar) instead of broken portal `modifyLabels` | v1 |
| MARK-02 | `mark read` falls back gracefully if primary path fails | v1 |
| COMPAT-01 | Existing search SQLite path (`sqlite-search.ts`) is reused, not duplicated | v1 |
| COMPAT-02 | All existing tests continue to pass | v1 |

## Success Criteria

- [ ] [READ-01] `superhuman read <thread-id>` returns thread content from local SQLite
- [ ] [READ-02] If SQLite DB not found, read falls back to network (portal/backend) transparently
- [ ] [LIST-01] `superhuman inbox` returns inbox threads from local SQLite
- [ ] [LIST-02] If SQLite DB not found, inbox falls back to network transparently
- [ ] [MARK-01] `superhuman mark read <thread-id>` returns success response (API returns 200 or equivalent)
- [ ] [MARK-02] Mark read has a working fallback path if primary method fails
- [ ] [COMPAT-01] Shared SQLite utilities from sqlite-search.ts are reused (no duplication)
- [ ] [COMPAT-02] `bun test` — all 274+ tests pass

## Constraints

- Reuse existing SQLite discovery/opening logic from `sqlite-search.ts`
- SQLite DB may not always have full message bodies — fallback to network for body if needed
- Thread IDs from `inbox` output are message IDs (latest.id), not Superhuman internal thread IDs — matching must handle both

## Testing Strategy (MANDATORY - USER APPROVED)

- **User's chosen approach:** Unit tests (bun:test)
- **Framework:** bun:test
- **Command:** `bun test`

### REAL Test Definition (MANDATORY)

| Field | Value |
|-------|-------|
| **User workflow to replicate** | `superhuman read <id>` returns thread messages; `superhuman inbox` returns thread list; `superhuman mark read <id>` succeeds |
| **Code paths that must be exercised** | SQLite open → query → parse → return; fallback to portal/backend on failure |
| **What user actually sees/verifies** | Thread content displayed, inbox listed, mark read succeeds |
| **Protocol/transport** | Local SQLite (bun:sqlite) primary, HTTP fallback |

### First Failing Test

- **Test name:** `read via SQLite returns thread messages when DB available`
- **What it tests:** That readThread tries SQLite first and returns parsed messages
- **How it replicates user workflow:** Mock SQLite DB with thread data, call readThread, verify messages returned
- **Expected failure message:** Currently readThread has no SQLite path — test will fail until implemented

## Open Questions (resolve during explore phase)

- What tables/schema does the local SQLite DB use for threads and messages?
- Does the DB contain full message bodies or just snippets?
- How does `list_ids` table map to INBOX/SH_IMPORTANT/SH_OTHER? Does it support split inbox (SH_IMPORTANT vs SH_OTHER)?
- What backend API endpoint can modify labels (read/unread) — `userdata.writeMessage` or another?
- Which functions from `sqlite-search.ts` should be reused (e.g., `findSuperhumanDb()`, DB open logic)?
