# Implementation Plan: SQLite-First Data Paths for read, inbox list, and mark read

> **For Claude:** REQUIRED SUB-SKILL: Discover and read `skills/dev-implement/SKILL.md` via cache lookup to implement this plan.
>
> **Delegation:** Main chat orchestrates, Task agents implement.

## Chosen Approach
**Extend existing modules**: Add SQLite paths directly in read.ts, inbox.ts, read-status.ts. Reuse findOPFSBlob/extractSQLite from sqlite-search.ts. ~200 lines across 3 files. No new abstractions.

## Rationale
- sqlite-search.ts already has all the SQLite plumbing (findOPFSBlob, extractSQLite, thread JSON parsing)
- Each module already has a fallback pattern (portal → backend) — we just prepend SQLite → portal → backend
- Keeps changes localized to the modules that own each operation

## Testing Strategy (MANDATORY - GATE)

| Field | Value | Status |
|-------|-------|--------|
| **Framework** | bun:test | [x] Filled |
| **Test Command** | `bun test` | [x] Filled |
| **First Failing Test** | `readThreadSQLite returns messages when DB has thread` — mock findOPFSBlob + extractSQLite, call readThread, verify messages returned from SQLite | [x] Filled |
| **Test File Location** | `src/__tests__/read-backend.test.ts`, `src/__tests__/inbox-backend.test.ts`, new `src/__tests__/read-status.test.ts` | [x] Filled |
| **Testing Skill** | Standard unit tests (bun:test with mock()) | [x] Filled |

## REAL Test Criteria (MANDATORY - PREVENTS FAKE TESTS)

| Criteria | Value | Verified |
|----------|-------|----------|
| **User workflow to replicate** | `superhuman read <id>` → messages shown; `superhuman inbox` → thread list; `superhuman mark read <id>` → success | [x] |
| **Protocol/transport** | Local SQLite (bun:sqlite) primary, HTTP fallback | [x] |
| **UI elements to interact with** | CLI output (terminal) | [x] |
| **What user sees/verifies** | Thread content displayed from local DB; inbox listed; mark read succeeds | [x] |
| **Code path exercised** | findOPFSBlob → extractSQLite → SQL query → parse JSON → return ThreadMessage[]/InboxThread[] | [x] |

## Files to Modify

| File | Change |
|------|--------|
| `src/sqlite-search.ts` | Export extractSQLite (currently private). Add `readThreadFromDB()` and `listInboxFromDB()` shared helpers. |
| `src/read.ts` | Add `readThreadSQLite()` path before portal/backend. Uses provider.getCurrentEmail() to find DB. |
| `src/inbox.ts` | Add `listInboxSQLite()` path before portal/backend. Queries threads + list_ids tables. |
| `src/read-status.ts` | Add backend API fallback for markAsRead/markAsUnread when portal fails. Use `userdata.writeMessage` or investigate label modification endpoint. |
| `src/__tests__/read-backend.test.ts` | Add SQLite-path tests (mock findOPFSBlob, extractSQLite, Database) |
| `src/__tests__/inbox-backend.test.ts` | Add SQLite-path tests |
| `src/__tests__/read-status.test.ts` | New: test mark read/unread with portal fallback |

## Implementation Order

| Task | Deps | Implements | Failing Test (write FIRST) | Verify Command |
|------|------|------------|----------------------------|----------------|
| 1. Export SQLite helpers from sqlite-search.ts | --- | COMPAT-01 | N/A (export only) | `bun test` (no regressions) |
| 2. SQLite path for readThread | after 1 | READ-01, READ-02 | `readThread uses SQLite when DB available` — mock DB with thread, verify messages returned | `bun test src/__tests__/read-backend.test.ts` |
| 3. SQLite path for listInbox | after 1 | LIST-01, LIST-02 | `listInbox uses SQLite when DB available` — mock DB with threads + list_ids, verify inbox returned | `bun test src/__tests__/inbox-backend.test.ts` |
| 4. Backend fallback for markAsRead/markAsUnread | --- | MARK-01, MARK-02 | `markAsRead falls back to backend when portal fails` — mock portalInvoke to throw, verify backendFetch called | `bun test src/__tests__/read-status.test.ts` |
| 5. Integration: verify all tests pass | after 2,3,4 | COMPAT-02 | N/A | `bun test` (all 274+ pass) |
