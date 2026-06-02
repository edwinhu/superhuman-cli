# Search misses an archived/starred thread that `star list` finds instantly

> **RESOLVED 2026-06-02** — all three root causes fixed in the same session.
> See "Resolution" at the bottom. The target thread now ranks **#1** for
> `search "leak"` (was #39) and `subject:leak is:starred` returns exactly it.

**Date:** 2026-06-02
**Account:** eddyhu@gmail.com (Gmail)
**Reporter symptom:** A real Gmail support thread ("[Sleep.me] Re: … Leak" from
help@sleep.me, Nov 2025 – Apr 2026, **starred**, archived/out-of-inbox) was
effectively unfindable via `superhuman search`. Every keyword and operator query
either returned only recent marketing blasts or nothing at all. Only
`superhuman star list` surfaced it.

- Thread ID passed by user: `19d607dc326517d1` (a **message** ID)
- Canonical thread_id in SQLite: `19a92997276093dc`
- 9 messages, last message **2026-04-06**

---

## TL;DR — root causes

The thread was **fully indexed the whole time.** Nothing was missing from the
index and there is no sync window problem. Search failed for three independent,
compounding reasons, all in the CLI's query layer — not the data layer:

1. **Recency-only ranking + a default limit of 10.** FTS results are ordered by
   `threads.sort DESC` (last-activity time), *not* by relevance. Plain
   `search "leak"` matched **63 threads**; the target sat at **result #39** at
   search time (its last message was Apr 6, and 38 newer threads also contain
   "leak" — newsletters, digests, etc.). With `limit=10` the user saw the 10
   newest "leak" newsletters and never the support thread. *(It happens to rank
   #1 right now only because starring it today bumped its `sort` to today.)*

2. **Gmail-style operators are silently turned into literal garbage tokens.**
   `subject:`, `from:`, `to:`, `is:starred`, `in:sent` are **not parsed at all.**
   `buildMatchExpr()` wraps every whitespace-delimited token in double quotes, so
   `subject:Leak` becomes the FTS phrase `"subject:Leak"` → **0 matches → no
   output.** The underlying FTS3 table *natively supports* column scoping
   (`subject:leak`, `from:taniza`, `labels:STARRED`) and would have found the
   thread instantly — the quoting destroys it.

3. **No fallback when local FTS returns zero rows.** `cmdSearch` only falls
   through to AI/server-side search when the SQLite blob is **absent**
   (`threads === null`). An empty result set (`[]`) is treated as authoritative
   ("No results"), so a buried/under-tokenized local hit is never rescued by the
   live API.

A fourth, milder factor: **tokenization.** The address `help@sleep.me` indexes as
the tokens `help`, `sleep`, `me`, and the joined form `sleep.me` — but **not
`sleepme`**. So `search "sleepme"` can never match this thread (it only matched
unrelated marketing that literally contains the token "sleepme"). `chilipad`
never appears in the thread at all, so that miss is expected.

---

## How the indexer/search actually works

### Data source
Superhuman keeps a per-account SQLite database as an **OPFS blob** inside the
browser profile (here: Dia), with a 4096-byte path header. `src/sqlite-search.ts`
finds the blob (`findOPFSBlob`), strips the header (`extractSQLite`), and queries
it read-only with `bun:sqlite`. **`search` and `star list` read the exact same
file** — so any "different data source" theory is wrong; the difference is purely
in *which table* and *how* each command queries.

### Schema (verified live)
- `threads(thread_id PK, json, sort, in_spam_trash, has_attachments, …)` — full
  thread JSON, **11,646 rows**.
- `thread_search` — **FTS3** virtual table, **11,646 rows** (1:1 with `threads`),
  `tokenize=porter`, columns:
  `thread_id, subject, content, from, to, cc, bcc, replyto, deliveredto,
  attachments, labels, list, rfc822msgid, meta`.
- `list_ids(thread_id, list_id)` — label/list membership (`INBOX`, `STARRED`,
  `SENT`, `SH_ALL`, `SH_OTHER`, Gmail `Label_*`, …).

The target's `thread_search` row contains `subject="Leak"`, body content, the
`from`/`to` addresses, and `labels="STARRED SENT … INBOX … SH_ALL SH_OTHER"`. It
is unambiguously in the index.

### `search` query path (`queryFTS`, `src/sqlite-search.ts:302`)
```sql
SELECT … FROM thread_search ts JOIN threads t ON ts.thread_id = t.thread_id
WHERE thread_search MATCH ?
ORDER BY t.sort DESC          -- recency, NOT relevance
LIMIT ?                       -- default 10 (cli.ts:439)
```
`?` is built by `buildMatchExpr()` → split on whitespace, wrap each token in
`"…"`, join with spaces. No operator handling whatsoever.

### `star list` query path (`listInboxFromDB` → `labels.ts:247`)
```sql
SELECT … FROM threads t JOIN list_ids li ON t.thread_id = li.thread_id
WHERE li.list_id = 'STARRED'
ORDER BY t.sort DESC LIMIT ?
```
No FTS, no MATCH, no relevance — a direct membership lookup. The starred thread
is one of a handful of `STARRED` rows, so it shows up regardless of recency or
tokenization. **That's why `star list` "found what search couldn't."** Same DB,
different table, no text-matching step to fail.

---

## Evidence (queries run against the live OPFS blob)

Rank reconstruction for `search "leak"` (ordered `sort DESC`, as the code does):

```
total "leak" hits: 63
target rank by sort DESC, pre-interaction: #39   (38 newer "leak" threads ahead of it)
default limit = 10  ->  target NOT shown
```

Operator behavior — **what the code sends** vs. **proper FTS3 column syntax**:

| User typed | Code sends to MATCH | Hits | Target | Proper FTS3 form | Hits | Target |
|---|---|---:|---|---|---:|---|
| `subject:Leak` | `"subject:Leak"` | 0 | miss | `subject:leak` | 4 | **FOUND** |
| `to:sleep.me` | `"to:sleep.me"` | 0 | miss | `to:sleep` | 1 | **FOUND** |
| `is:starred` | `"is:starred"` | 0 | miss | `labels:STARRED` | 14 | **FOUND** |
| `in:sent` | `"in:sent"` | 0 | miss | `labels:SENT` | 1133 | **FOUND** |
| (n/a) | — | — | — | `from:taniza` | 1 | **FOUND** |
| (n/a) | — | — | — | `subject:leak labels:STARRED` | 1 | **FOUND** |

Tokenization of the target row:

```
"leak"      -> in target: YES        "sleep"     -> YES
"sleep.me"  -> YES                    "dock"      -> YES
"sleepme"   -> NO  (address tokenizes as sleep/me/sleep.me, never "sleepme")
"chilipad"  -> NO  (term not present in this thread at all)
```

So of the user's attempts:
- `search "leak"` → **would have worked** with a higher limit or relevance
  ranking (target was hit #39).
- `search "sleepme"` → **could never work**; wrong token. `"sleep"`, `"sleep.me"`,
  or `"dock pro"` would have hit.
- `search "chilipad"` → correctly no match (not in thread).
- `subject:Leak`, `to:sleep.me`, `in:sent Leak`, `is:starred` → **all 0 hits**
  purely because of the quoting bug; the native column forms all FOUND it.

---

## Which query operators are real vs. no-ops (current behavior)

**None of the Gmail-style operators work today.** The FTS layer is given
whitespace-split, fully-quoted phrase tokens, so:

| Operator | Status today | Why |
|---|---|---|
| bare keywords (`leak`, `dock`) | ✅ works | quoted single token = term match |
| multi-word (`dock pro`) | ⚠️ works as **AND of two phrase tokens**, not a phrase | `"dock" "pro"` |
| `subject:` | ❌ no-op | becomes literal `"subject:…"` |
| `from:` | ❌ no-op | literal `"from:…"` |
| `to:` | ❌ no-op | literal `"to:…"` |
| `cc:` / `bcc:` | ❌ no-op | literal |
| `is:starred` | ❌ no-op | literal; not even an FTS column (needs map → `labels:STARRED`) |
| `in:sent` / `in:inbox` | ❌ no-op | literal; needs map → `labels:SENT` / `labels:INBOX` |
| `has:attachment` | ❌ no-op | literal; could map → `labels:` or `threads.has_attachments` |
| OR / `-term` exclusion | ❌ not honored | every token is quoted & implicitly ANDed |

The FTS3 table itself **does** support `column:term`, `OR`, `NOT`, and `-` — the
CLI just never lets those through. The docs/help text advertises
`search "from:john subject:meeting"` (cli.ts:235) as if it works; it does not.

### Why `--ai` returned nothing
`--ai` / `--include-done` route to `askAISearch()` (`token-api.ts:1497`,
`ai.askAIProxy`). This is an agentic/RAG endpoint, not a deterministic search:

- The CLI passes the **raw query string verbatim**, including Gmail operators.
  `subject:Leak` / `is:starred` are meaningless as natural language to the proxy,
  so it has nothing useful to retrieve and tends to answer in prose with an empty
  `retrievals` array.
- The CLI prints only `aiResult.response` + the `retrievals` thread IDs. If the
  model returns just a `<thinking>` block or a "couldn't find it" sentence with
  no retrievals, the user sees **nothing actionable**.
- There is **no empty-response guard and no timeout**: a stream that closes after
  emitting only thinking yields `{response: "", retrievals: []}` — silent empty.
- It is also non-deterministic and keyword-sensitive; a single token like
  "sleepme" may produce a conversational reply rather than surfacing the thread.

(The endpoint is wired correctly — 401/refresh/SSE parsing all look fine — so the
failure is "garbage-in + silent-empty-out," not a hard bug.)

---

## Recommended fixes

Ordered by impact-to-effort.

### 1. Parse Gmail-style operators into FTS3 column syntax (biggest win)
Add a query preprocessor in `sqlite-search.ts` that runs **before**
`buildMatchExpr` and recognizes `field:value` and `is:`/`in:`/`has:` tokens,
emitting native FTS3 instead of quoting them:

- `subject:X` → `subject:X` (unquoted column scope; quote only the value if it
  contains spaces/punctuation that the tokenizer would split)
- `from:X` → `from:X`, `to:X` → `to:X`, `cc:` / `bcc:` likewise
- `is:starred` → `labels:STARRED`; `is:unread`/`is:read` → map to label tokens
- `in:sent` → `labels:SENT`, `in:inbox` → `labels:INBOX`, `in:trash`/`in:spam`
  → handle via `threads.in_spam_trash`
- `has:attachment` → `labels:…` or filter on `threads.has_attachments`
- bare terms → current behavior (quoted term)
- support leading `-` for exclusion (`NOT`) and bare `OR`

Verified: `subject:leak`, `from:taniza`, `labels:STARRED`, and the combo
`subject:leak labels:STARRED` each return the target. This single change fixes
four of the user's five failed queries.

### 2. Stop ranking purely by recency / raise or remove the default cap
`ORDER BY t.sort DESC LIMIT 10` is the reason a real result lost to newsletters.
Options (combine):
- Rank by **FTS relevance** (FTS3 `matchinfo()`-based scoring, or migrate the
  table to **FTS5** and use `bm25()`), then break ties by recency.
- Raise the default `limit` for `search` (e.g. 25–50) — `star list` already
  defaults to 50.
- When the result set is large, print a "showing N of M — refine or raise
  `--limit`" hint so users know there's a tail.

### 3. Fall back to live/AI search when local FTS returns **zero** rows
In `cmdSearch`, the `threads !== null && threads.length === 0` case should
attempt the AI/server-side path (and/or a `star list`-style label scan) instead
of printing "No results". Treat empty-local as "inconclusive," not authoritative.

### 4. Make `--ai` robust
- Strip/translate Gmail operators before sending (reuse the #1 parser, or fall
  back to a plain keyword extraction) so the proxy gets a natural-language query.
- Guard empty results: if `response` is blank **and** `retrievals` is empty,
  say so explicitly and auto-retry via the local FTS path (or vice-versa).
- Add a read timeout so a hung/empty stream doesn't look like "no results."

### 5. Tokenization / fuzzy address matching (lower priority)
Because `help@sleep.me` never indexes as `sleepme`, consider: (a) also matching
on the domain label, (b) normalizing punctuation in address queries, or at least
(c) documenting that address searches should use the real token (`sleep.me`,
`sleep`, or `from:taniza`). Migrating to FTS5 with a custom/unicode tokenizer
would let `sleepme`↔`sleep.me` be handled more gracefully.

### 6. Fix the docs/help to match reality
`cli.ts` currently advertises `search "from:john subject:meeting"` and
`from:anthropic` as working examples. Either implement #1 (preferred) or correct
the help text so it doesn't promise operators that are silently ignored.

---

## Answers to the specific questions asked

1. **Is there a sync/time window that excludes old/archived mail?** No. The FTS
   index is 1:1 with the threads table (11,646 each) and contained this thread,
   including its Nov-2025→Apr-2026 messages and its `STARRED` label. No staleness
   involved.
2. **Does `search` exclude archived/"done" unless `--include-done`?** Not at the
   data level — `thread_search` indexes everything regardless of folder.
   `--include-done` does **not** change the local FTS query at all; it merely
   **reroutes** the whole command to the AI/server path (`useAI = ai ||
   includeDone`). So "include-done" is a misnomer: local search already covers
   archived mail; the flag just swaps engines.
3. **Why did `--ai` return nothing?** Raw Gmail operators are meaningless to the
   `ai.askAIProxy` RAG endpoint, and the code silently prints empty when the
   model returns no retrievals (no empty-guard, no timeout, no fallback).
4. **Are Gmail operators parsed?** No — all of `subject:`/`to:`/`from:`/
   `in:sent`/`is:starred` are silently quoted into literal phrase tokens that
   match nothing. Only bare keywords work. FTS3 *natively* supports the column
   forms; the CLI just never emits them.
5. **Why does `star list` find what `search` can't?** Same SQLite DB, different
   table and no text step: `star list` does a direct `list_ids.list_id =
   'STARRED'` membership join (no MATCH, no tokenizer, no relevance, limit 50),
   so it can't be defeated by ranking, the limit, or tokenization the way the FTS
   `search` path was.

---

## Resolution (implemented 2026-06-02)

All three root causes plus the operator gap were fixed:

**1. Shared Gmail-operator → FTS3 parser** (`buildFtsMatchExpr`, exported from
`src/sqlite-search.ts`; also now used by the portal path in `src/inbox.ts` so
both FTS engines share identical semantics). Supports `subject:` `from:` `to:`
`cc:` `bcc:` `body:` `replyto:`, `is:`/`in:`/`label:` (mapped to the `labels`
column, e.g. `is:starred`→`labels:STARRED`, `in:sent`→`labels:SENT`), `-term`
negation (binary `NOT`), and `"quoted phrases"`. Unknown operators (e.g. `has:`)
are dropped rather than matched as literal junk. Covered by
`src/__tests__/fts-query-parser.test.ts` (17 cases).

**2. Relevance ranking** replaced pure-recency ordering in `queryFTS`. It now
ranks matches by a column-weighted `matchinfo(thread_search, 'pcx')` score
(subject ×10, from ×6, to ×4, content ×2, others ×1) with recency as the
tie-breaker. Implemented as a two-pass query: pass 1 ranks all candidates
(JSON-free, capped at 5000), pass 2 fetches JSON + snippets for the selected
page only. `searchDirect` now returns `{ threads, total }`.

**3. Empty-result fallback + "showing N of M" hint** in `cmdSearch`
(`src/cli.ts`). A non-empty local result is terminal; an **empty** local result
now falls through to AI/server-side search (after dropping the CDP connection so
the `fetch` doesn't hang) instead of printing "No results". When the match count
exceeds the page, it prints `Showing top N of M by relevance — use --limit …`.

**4. `--ai` empty guard**: if the AI returns no narrative and no retrievals, the
CLI now says "No results" with a hint that AI search wants natural language, not
Gmail operators — instead of printing nothing.

**Verified end-to-end** against the live `eddyhu@gmail.com` OPFS blob:

| Query | Before | After |
|---|---|---|
| `search "leak"` | target #39 of 63, off-page | **#1** of 63, page shows "10 of 63" hint |
| `subject:leak is:starred` | 0 results (literal `"subject:Leak"`) | **1 result** — the target |
| `from:taniza` | 0 results | **1 result** — the target |
| `leak -newsletter` | n/a (no negation) | 27 results, target #1 |
| `has:attachment leak` | 0 (literal `"has:attachment"`) | dropped → behaves as `leak`, target #1 |

Not changed (documented limitations): address tokenization still indexes
`help@sleep.me` as `sleep`/`me`/`sleep.me` but not `sleepme` (would need an FTS5
migration with a custom tokenizer); `has:attachment` is parsed-but-dropped rather
than filtered on `threads.has_attachments`.

## Review hardening (post code-review, 2026-06-02)
- **FTS injection / crash fix:** operator values are unquotable in FTS3, so
  punctuation in a value (`subject:foo(bar`, `from:a"b`) used to produce a
  malformed MATCH and crash `search` with an unhandled SQLite error. `mapOperator`
  now runs values through `sanitizeFtsTokens` (strip FTS metacharacters → bare
  word tokens; drop bareword OR/AND/NOT/NEAR), label values keep only `[A-Z0-9_]`,
  and the parser's final fallback is sanitized too. `queryFTS` also wraps the
  MATCH in a try/catch that retries with a plain quoted-keyword query and returns
  empty rather than throwing. Covered by new cases in `fts-query-parser.test.ts`.
- **Honest truncation:** `searchDirect` now returns `capped` (true when matches
  hit `MAX_RANK_CANDIDATES`); the hint reads "Showing top N of M+ … refine your
  query" so the cap isn't presented as the true total.
