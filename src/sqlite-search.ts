/**
 * Direct SQLite Search
 *
 * Queries Superhuman's local SQLite FTS3 index directly from disk, bypassing
 * Chrome/CDP entirely. Superhuman stores per-account SQLite databases as OPFS
 * blobs in the browser's File System storage with a 4096-byte header.
 *
 * Header format: null-terminated path string (e.g. "/user@example.com.sqlite3")
 * padded to 4096 bytes, followed by raw SQLite data.
 *
 * Supported browsers: Dia, Chromium, Chrome, Brave (all use the same OPFS layout).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import type { InboxThread } from "./inbox";

// Browser OPFS storage roots, checked in preference order
const BROWSER_ROOTS = [
  join(homedir(), "Library/Application Support/Dia/User Data"),
  join(homedir(), "Library/Application Support/Chromium/User Data"),
  join(homedir(), "Library/Application Support/Google/Chrome/User Data"),
  join(homedir(), "Library/Application Support/Google/Chrome"),
  join(homedir(), "Library/Application Support/BraveSoftware/Brave-Browser/User Data"),
  // Linux paths
  join(homedir(), ".config/chromium"),
  join(homedir(), ".config/google-chrome"),
  join(homedir(), ".config/BraveSoftware/Brave-Browser"),
];

const OPFS_HEADER_SIZE = 4096;

/**
 * Find the OPFS blob file for a given account email across all known browser
 * data directories and profiles.
 */
export function findOPFSBlob(accountEmail: string): string | null {
  const targetSuffix = `/${accountEmail}.sqlite3`;

  for (const root of BROWSER_ROOTS) {
    if (!existsSync(root)) continue;

    // Scan all File System buckets in all profiles under this root
    const blobs = findBlobsInRoot(root);
    for (const blobPath of blobs) {
      const email = readOPFSHeader(blobPath);
      if (email && email.toLowerCase() === targetSuffix.toLowerCase()) {
        return blobPath;
      }
    }
  }
  return null;
}

/**
 * Return all OPFS blob file paths under a browser User Data root.
 * Blobs live at: {root}/{Profile}/File System/{bucket}/t/00/{id}
 */
function findBlobsInRoot(root: string): string[] {
  const results: string[] = [];
  try {
    const profileDirs = Bun.spawnSync(["find", root, "-maxdepth", "2", "-name", "File System", "-type", "d"]);
    const fsDirs = new TextDecoder().decode(profileDirs.stdout).trim().split("\n").filter(Boolean);
    for (const fsDir of fsDirs) {
      // Each File System dir has numbered bucket subdirs (000, 001, ...)
      const buckets = Bun.spawnSync(["find", fsDir, "-maxdepth", "1", "-mindepth", "1", "-type", "d"]);
      const bucketDirs = new TextDecoder().decode(buckets.stdout).trim().split("\n").filter(Boolean);
      for (const bucket of bucketDirs) {
        const blobDir = join(bucket, "t", "00");
        if (!existsSync(blobDir)) continue;
        const files = Bun.spawnSync(["find", blobDir, "-maxdepth", "1", "-type", "f"]);
        const filePaths = new TextDecoder().decode(files.stdout).trim().split("\n").filter(Boolean);
        for (const f of filePaths) {
          // Quick size check — Superhuman DBs are at least 1MB
          try {
            const stat = Bun.file(f).size;
            if (stat > 1_000_000) results.push(f);
          } catch {}
        }
      }
    }
  } catch {}
  return results;
}

/**
 * Read the path prefix from an OPFS blob header.
 * Returns the path string (e.g. "/user@example.com.sqlite3") or null.
 */
function readOPFSHeader(blobPath: string): string | null {
  try {
    const file = Bun.file(blobPath);
    // Read just the header synchronously using Node fs
    const { readFileSync } = require("fs");
    const header = readFileSync(blobPath, { flag: "r" }).slice(0, OPFS_HEADER_SIZE) as Buffer;
    // Must start with '/' and contain '.sqlite3'
    if (header[0] !== 0x2f) return null; // '/'
    const nullPos = header.indexOf(0, 1);
    if (nullPos < 0) return null;
    const path = header.slice(0, nullPos).toString("utf8");
    if (!path.includes(".sqlite3")) return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * Extract the SQLite data portion of an OPFS blob to a temp file.
 * Returns the temp file path (caller should delete when done).
 */
export function extractSQLite(blobPath: string): string {
  const { readFileSync } = require("fs");
  const data = readFileSync(blobPath) as Buffer;
  const sqliteData = data.slice(OPFS_HEADER_SIZE);

  const tmpPath = join(tmpdir(), `superhuman-search-${Date.now()}.sqlite3`);
  writeFileSync(tmpPath, sqliteData);
  return tmpPath;
}

/**
 * Thread metadata returned by lookupThreadInfoById.
 * Matches the shape of ThreadInfoDirect from token-api.ts.
 */
export interface SQLiteThreadInfo {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  messageId: string | null;
  references: string[];
  /** Gmail API message ID (hex, e.g. "19d3fa80bff87ca3") of the latest message */
  gmailMessageId: string | null;
  /** Provider message ids of ALL non-draft messages in the thread, oldest→newest.
   *  These are exactly what the Superhuman app puts in
   *  outgoing_message.current_message_ids when sending a reply (verified: they
   *  match the app byte-for-byte). Using the conversation/thread id instead — as
   *  the old MS path did — makes the backend accept the send (200) then silently
   *  fail to deliver. */
  messageIds: string[];
  /** ISO date string of the latest message */
  date: string | null;
  /** The canonical thread_id from SQLite (O365 Conversation ID). Use this for
   *  inReplyToThreadId — it may differ from the inbox ID the user passed in. */
  canonicalThreadId: string | null;
  /** All unique participants across the thread (for reply-to-self fallback) */
  allParticipants?: string[];
}

/**
 * Look up a single thread by its hex ID directly from the local SQLite blob.
 * Returns null if the OPFS blob or thread cannot be found.
 *
 * This is the primary way to get thread metadata for reply/forward when the
 * Superhuman REST API is unavailable (userdata.getThreads requires browser auth).
 */
export function lookupThreadInfoById(
  accountEmail: string,
  threadId: string
): SQLiteThreadInfo | null {
  const blobPath = findOPFSBlob(accountEmail);
  if (!blobPath) return null;

  const tmpPath = extractSQLite(blobPath);
  try {
    const db = new Database(tmpPath, { readonly: true });
    try {
      // 1. Exact match on thread_id (conversation ID)
      let row = db.query<{ thread_id: string; json: string }>(
        "SELECT thread_id, json FROM threads WHERE thread_id = ?"
      ).get(threadId);

      // 2. Fallback: search by message ID inside the JSON blob.
      // Inbox returns message-level IDs (O365 Item IDs) which differ from
      // the thread_id (O365 Conversation ID) stored as the primary key.
      if (!row) {
        row = db.query<{ thread_id: string; json: string }>(
          "SELECT t.thread_id, t.json FROM threads t WHERE t.json LIKE ? LIMIT 1"
        ).get(`%"id":"${threadId}"%`);
      }

      if (!row) return null;

      let json: any;
      try {
        json = JSON.parse(row.json);
      } catch {
        return null;
      }

      const messages: any[] = Array.isArray(json.messages)
        ? json.messages
        : typeof json.messages === "object" && json.messages !== null
        ? Object.values(json.messages)
        : [];

      if (messages.length === 0) return null;

      messages.sort(
        (a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
      );
      const latest = messages[messages.length - 1];

      const formatAddr = (a: any): string => {
        if (!a) return "";
        if (typeof a === "string") return a;
        const name = (a.name || "").trim();
        const email = a.email || "";
        return name ? `${name} <${email}>` : email;
      };

      const toList = Array.isArray(latest.to) ? latest.to.map(formatAddr).filter(Boolean)
        : latest.to ? [formatAddr(latest.to)] : [];
      const ccList = Array.isArray(latest.cc) ? latest.cc.map(formatAddr).filter(Boolean)
        : latest.cc ? [formatAddr(latest.cc)] : [];

      // Collect all unique participants across the thread for reply-to-self fallback
      const participantSet = new Set<string>();
      for (const m of messages) {
        if (m.from) participantSet.add(formatAddr(m.from));
        const addrs = Array.isArray(m.to) ? m.to : m.to ? [m.to] : [];
        for (const a of addrs) participantSet.add(formatAddr(a));
        const ccs = Array.isArray(m.cc) ? m.cc : m.cc ? [m.cc] : [];
        for (const a of ccs) participantSet.add(formatAddr(a));
      }

      return {
        subject: latest.subject || json.subject || "",
        from: formatAddr(latest.from),
        to: toList,
        cc: ccList,
        messageId: latest.rfc822Id || latest.messageId || null,
        references: Array.isArray(latest.references) ? latest.references : [],
        gmailMessageId: latest.id || null,
        messageIds: messages
          .filter((m: any) => !m.draft && !(m.labelIds || []).includes("DRAFT") && m.id)
          .map((m: any) => m.id as string),
        date: latest.date || null,
        canonicalThreadId: row.thread_id,
        allParticipants: [...participantSet].filter(Boolean),
      };
    } finally {
      db.close();
    }
  } finally {
    try { rmSync(tmpPath); } catch {}
  }
}

export interface DirectSearchOptions {
  query: string;
  limit?: number;
  accountEmail: string;
}

export interface DirectSearchResult {
  /** The ranked page of results (length <= limit). */
  threads: InboxThread[];
  /** Number of matched threads considered for ranking (may exceed threads.length). */
  total: number;
  /** True when matches were capped at MAX_RANK_CANDIDATES, so `total` is a floor. */
  capped: boolean;
}

/**
 * Search the Superhuman SQLite FTS3 index directly from the OPFS blob on disk.
 * No CDP or browser connection required.
 *
 * Returns the ranked page plus the total match count, or null if the OPFS blob
 * cannot be found for this account. Results are ranked by column-weighted
 * relevance (subject/sender matches outrank body matches), with recency as the
 * tie-breaker — NOT pure recency, which previously buried older-but-exact hits.
 */
export async function searchDirect(options: DirectSearchOptions): Promise<DirectSearchResult | null> {
  const blobPath = findOPFSBlob(options.accountEmail);
  if (!blobPath) return null;

  const tmpPath = extractSQLite(blobPath);
  try {
    return queryFTS(tmpPath, options.query, options.limit ?? 50);
  } finally {
    try { rmSync(tmpPath); } catch {}
  }
}

/**
 * List all accounts that have a local Superhuman SQLite database.
 */
export function listLocalAccounts(): string[] {
  const accounts: string[] = [];
  for (const root of BROWSER_ROOTS) {
    if (!existsSync(root)) continue;
    const blobs = findBlobsInRoot(root);
    for (const blobPath of blobs) {
      const header = readOPFSHeader(blobPath);
      if (!header) continue;
      // Strip leading '/' and trailing '.sqlite3'
      const email = header.replace(/^\//, "").replace(/\.sqlite3$/, "");
      if (email.includes("@") && !accounts.includes(email)) {
        accounts.push(email);
      }
    }
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// FTS query parsing (Gmail-style operators -> native FTS3)
// ---------------------------------------------------------------------------

/** Wrap a bare term/phrase as an FTS3 phrase token. */
function escapeFtsToken(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Split a query into tokens, keeping `"quoted phrases"` and `field:"quoted
 * values"` intact, and preserving a leading `-` negation marker.
 */
function tokenizeQuery(queryStr: string): string[] {
  const tokens: string[] = [];
  const re = /-?(?:[a-zA-Z]+:)?"[^"]*"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(queryStr)) !== null) tokens.push(m[0]);
  return tokens;
}

// Gmail-style field operators -> FTS3 `thread_search` column names.
const COLUMN_OPERATORS: Record<string, string> = {
  subject: "subject",
  from: "from",
  to: "to",
  cc: "cc",
  bcc: "bcc",
  body: "content",
  replyto: "replyto",
};

// Gmail is:/in: tokens -> values stored in the FTS `labels` column.
const LABEL_SYNONYMS: Record<string, string> = {
  starred: "STARRED",
  unread: "UNREAD",
  important: "IMPORTANT",
  flagged: "FLAGGED",
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  drafts: "DRAFT",
  spam: "SPAM",
  trash: "TRASH",
};

/** Strip surrounding double-quotes from an operator value. */
function unquote(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

/**
 * Split an operator value into safe, bare FTS3 tokens. Column filters (`col:tok`)
 * cannot be quoted, so any FTS3 metacharacter in the value — `" * ( ) : ^ -` or a
 * bareword operator like OR/NOT/NEAR — would corrupt or break the MATCH expression
 * (an unbalanced `(` or stray `"` makes SQLite throw "malformed MATCH expression").
 * We replace all such metacharacters with spaces and keep only word runs, so e.g.
 * `foo(bar` -> ["foo","bar"] and `a"b` -> ["a","b"]. The porter tokenizer already
 * splits on punctuation, so this preserves matching while staying injection-safe.
 */
function sanitizeFtsTokens(value: string): string[] {
  return value
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    // Bareword FTS operators are only special when standalone; column-scoped they
    // are plain tokens, but drop them defensively to avoid any parser ambiguity.
    .filter((t) => !/^(OR|AND|NOT|NEAR)$/i.test(t));
}

/**
 * Translate one `field:value` operator into an FTS3 fragment, or null when the
 * operator is unknown / unsupported (e.g. `has:`) so the caller can drop it.
 */
function mapOperator(field: string, rawValue: string): string | null {
  const f = field.toLowerCase();
  const value = unquote(rawValue).trim();
  if (!value) return null;

  const col = COLUMN_OPERATORS[f];
  if (col) {
    // FTS3 column filters bind to a single following token, so emit one
    // `col:token` per sanitized word. Same-column tokens AND together.
    const words = sanitizeFtsTokens(value);
    return words.map((w) => `${col}:${w}`).join(" ") || null;
  }

  if (f === "is" || f === "in") {
    const synonym = LABEL_SYNONYMS[value.toLowerCase()];
    // Label values live in the labels column; keep only label-safe chars.
    const label = synonym || value.toUpperCase().replace(/[^A-Z0-9_]/g, "");
    return label ? `labels:${label}` : null;
  }

  if (f === "label") {
    const label = value.toUpperCase().replace(/[^A-Z0-9_]/g, "");
    return label ? `labels:${label}` : null;
  }

  // Unknown / unsupported operator -> signal "drop this token".
  return null;
}

/**
 * Build an FTS3 MATCH expression from a Gmail-style query.
 *
 * Supports: bare terms, `"quoted phrases"`, field operators
 * (`subject:` `from:` `to:` `cc:` `bcc:` `body:` `replyto:`), `is:`/`in:`/
 * `label:` (mapped to the `labels` column, e.g. `is:starred` -> `labels:STARRED`,
 * `in:sent` -> `labels:SENT`), and leading `-` negation. Unknown operators
 * (e.g. `has:`) are dropped.
 *
 * Exported so the portal FTS path (inbox.ts) shares identical semantics.
 */
export function buildFtsMatchExpr(queryStr: string): string {
  const positives: string[] = [];
  const negatives: string[] = [];

  for (const tok of tokenizeQuery(queryStr)) {
    let neg = false;
    let s = tok;
    if (s.startsWith("-") && s.length > 1) {
      neg = true;
      s = s.slice(1);
    }

    // field:value operator (field is letters only; value is the remainder)
    const opMatch = s.match(/^([a-zA-Z]+):(.+)$/);
    if (opMatch) {
      const frag = mapOperator(opMatch[1] ?? "", opMatch[2] ?? "");
      if (frag) (neg ? negatives : positives).push(frag);
      // Unknown operator -> token dropped entirely.
      continue;
    }

    // bare term or quoted phrase
    (neg ? negatives : positives).push(escapeFtsToken(unquote(s)));
  }

  let expr = positives.join(" ");
  // FTS3 NOT is binary; only apply negation when there is a positive side.
  if (negatives.length && expr) {
    for (const n of negatives) expr += ` NOT ${n}`;
  }

  if (expr) return expr;

  // Nothing usable parsed (e.g. only unknown operators, or values that sanitized
  // to nothing). Fall back to a SANITIZED keyword phrase search so the result can
  // never contain raw FTS metacharacters that would break MATCH.
  const fallback = sanitizeFtsTokens(queryStr).map(escapeFtsToken).join(" ");
  return fallback || `""`;
}

// ---------------------------------------------------------------------------
// FTS relevance ranking
// ---------------------------------------------------------------------------

// Per-column weights, indexed by FTS column position in `thread_search`:
// 0 thread_id, 1 subject, 2 content, 3 from, 4 to, 5 cc, 6 bcc, 7 replyto,
// 8 deliveredto, 9 attachments, 10 labels, 11 list, 12 rfc822msgid, 13 meta.
// Subject and sender matches are weighted far above body matches so an exact
// subject hit outranks newer threads that merely mention the term in the body.
const COLUMN_WEIGHTS = [0, 10, 2, 6, 4, 2, 1, 1, 1, 1, 1, 1, 1, 1];

// Upper bound on rows pulled into the in-memory relevance ranker. Far above any
// realistic result set; protects against a pathological single-token query.
const MAX_RANK_CANDIDATES = 5000;

/**
 * Compute a relevance score from an FTS3 `matchinfo(tbl, 'pcx')` blob.
 * Layout: [p, c, then for each of p phrases x c columns: 3 uint32s, the first
 * of which is the hit count for that phrase in that column in THIS row].
 */
function scoreMatchInfo(blob: Uint8Array | null): number {
  if (!blob || blob.byteLength < 8) return 0;
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const u = (i: number) => dv.getUint32(i * 4, true);
  const p = u(0);
  const c = u(1);
  let score = 0;
  for (let t = 0; t < p; t++) {
    for (let col = 0; col < c; col++) {
      const hits = u(2 + (t * c + col) * 3);
      if (hits) score += hits * (COLUMN_WEIGHTS[col] ?? 1);
    }
  }
  return score;
}

/**
 * Run pass-1 candidate selection for a MATCH expression. Isolated so the caller
 * can retry with a safe fallback expression if a hand-built expression turns out
 * to be malformed (SQLite throws "malformed MATCH expression").
 */
function runCandidateQuery(
  db: Database,
  matchExpr: string
): Array<{ thread_id: string; sort: number; mi: Uint8Array }> {
  return db.query<{ thread_id: string; sort: number; mi: Uint8Array }>(`
    SELECT ts.thread_id AS thread_id, t.sort AS sort,
           matchinfo(thread_search, 'pcx') AS mi
    FROM thread_search ts
    JOIN threads t ON ts.thread_id = t.thread_id
    WHERE thread_search MATCH ?
    ORDER BY t.sort DESC
    LIMIT ?
  `).all(matchExpr, MAX_RANK_CANDIDATES);
}

function queryFTS(dbPath: string, queryStr: string, limit: number): DirectSearchResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    const matchExpr = buildFtsMatchExpr(queryStr);

    // Pass 1: rank all matches by column-weighted relevance, tie-break recency.
    // Backstop: if the parsed expression is somehow still malformed, retry with a
    // plain fully-quoted token query so a bad query degrades to keyword search
    // instead of crashing `superhuman search` with an unhandled SQLite error.
    let candidates: Array<{ thread_id: string; sort: number; mi: Uint8Array }>;
    try {
      candidates = runCandidateQuery(db, matchExpr);
    } catch {
      const safeExpr = queryStr.trim().split(/\s+/).filter(Boolean)
        .map(escapeFtsToken).join(" ") || escapeFtsToken(queryStr.trim());
      try {
        candidates = runCandidateQuery(db, safeExpr);
      } catch {
        return { threads: [], total: 0, capped: false };
      }
    }

    const total = candidates.length;
    const capped = total >= MAX_RANK_CANDIDATES;
    if (total === 0) return { threads: [], total: 0, capped: false };

    const scored = candidates.map((c) => ({
      thread_id: c.thread_id,
      sort: c.sort ?? 0,
      score: scoreMatchInfo(c.mi),
    }));
    scored.sort((a, b) => (b.score - a.score) || (b.sort - a.sort));
    const topIds = scored.slice(0, limit).map((s) => s.thread_id);

    // Pass 2: fetch JSON + snippets for the selected page only.
    const placeholders = topIds.map(() => "?").join(",");
    const rows = db.query<{
      thread_id: string;
      json: string;
      subject_snippet: string;
      body_snippet: string;
    }>(`
      SELECT
        ts.thread_id,
        t.json,
        snippet(thread_search, '<b>', '</b>', '…', 1, -64) AS subject_snippet,
        snippet(thread_search, '<b>', '</b>', '…', 2, -15) AS body_snippet
      FROM thread_search ts
      JOIN threads t ON ts.thread_id = t.thread_id
      WHERE thread_search MATCH ? AND ts.thread_id IN (${placeholders})
    `).all(matchExpr, ...topIds);
    const rowMap = new Map(rows.map((r) => [r.thread_id, r]));

    // Batch list_ids query for the page's threads.
    const labelMap = new Map<string, string[]>();
    if (topIds.length > 0) {
      const labelRows = db.query<{ thread_id: string; list_id: string }>(
        `SELECT thread_id, list_id FROM list_ids WHERE thread_id IN (${placeholders})`
      ).all(...topIds);
      for (const lr of labelRows) {
        const arr = labelMap.get(lr.thread_id) ?? [];
        arr.push(lr.list_id);
        labelMap.set(lr.thread_id, arr);
      }
    }

    // Build results in ranked order (topIds order), not pass-2 row order.
    const threads = topIds.map((tid): InboxThread | null => {
      const row = rowMap.get(tid);
      if (!row) return null;
      let json: any;
      try {
        json = typeof row.json === "string" ? JSON.parse(row.json) : row.json;
      } catch {
        return null;
      }
      if (!json?.id) return null;

      const messages: any[] = Array.isArray(json.messages)
        ? json.messages
        : typeof json.messages === "object" && json.messages !== null
        ? Object.values(json.messages)
        : [];

      messages.sort(
        (a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
      );
      const latest = messages[messages.length - 1];

      const from = latest?.from;
      const fromParsed = !from
        ? { email: "", name: "" }
        : typeof from === "string"
        ? parseFromStr(from)
        : { email: from.email || "", name: from.name || "" };

      return {
        id: json.id,
        subject: row.subject_snippet.replace(/<[^>]*>/g, "") || latest?.subject || "",
        from: fromParsed,
        date: latest?.date || "",
        snippet: row.body_snippet.replace(/<[^>]*>/g, "") || latest?.snippet || "",
        labelIds: labelMap.get(row.thread_id) ?? latest?.labelIds ?? [],
        messageCount: messages.length,
      };
    }).filter((t): t is InboxThread => t !== null);

    return { threads, total, capped };
  } finally {
    db.close();
  }
}

function parseFromStr(from: string): { email: string; name: string } {
  const match = from.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from, name: from };
}

// ---------------------------------------------------------------------------
// Direct DB read/list helpers
// ---------------------------------------------------------------------------

/**
 * Read a single thread from the local SQLite database by thread ID or message ID.
 *
 * First tries exact match on thread_id, then falls back to searching inside
 * the JSON blob for a matching message ID (users often pass message IDs from
 * inbox output rather than thread IDs).
 *
 * Returns the parsed JSON object (with `.messages` normalized to an array) or null.
 */
export function readThreadFromDB(
  accountEmail: string,
  threadId: string
): Record<string, unknown> | null {
  const blobPath = findOPFSBlob(accountEmail);
  if (!blobPath) return null;

  const tmpPath = extractSQLite(blobPath);
  try {
    const db = new Database(tmpPath, { readonly: true });
    try {
      // 1. Exact match on thread_id
      let row = db.query<{ thread_id: string; json: string }>(
        "SELECT thread_id, json FROM threads WHERE thread_id = ?"
      ).get(threadId);

      // 2. Fallback: search by message ID inside the JSON
      if (!row) {
        row = db.query<{ thread_id: string; json: string }>(
          "SELECT t.thread_id, t.json FROM threads t WHERE t.json LIKE ? LIMIT 1"
        ).get(`%"id":"${threadId}"%`);
      }

      if (!row) return null;

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(row.json);
      } catch {
        return null;
      }

      // Normalize messages to array
      const rawMessages = (json as any).messages;
      const messages: unknown[] = Array.isArray(rawMessages)
        ? rawMessages
        : typeof rawMessages === "object" && rawMessages !== null
        ? Object.values(rawMessages)
        : [];
      json.messages = messages;
      // Attach the canonical thread_id from the DB row so callers can use the
      // correct conversation ID (may differ from the message-level ID passed in).
      json._canonicalThreadId = row.thread_id;

      return json;
    } finally {
      db.close();
    }
  } finally {
    try { rmSync(tmpPath); } catch {}
  }
}

export interface ListInboxRow {
  threadId: string;
  json: string;
  labelIds: string[];
}

/**
 * List threads from a specific inbox list (e.g. "INBOX", "SH_IMPORTANT",
 * "SH_OTHER") directly from the local SQLite database.
 *
 * Returns raw rows with thread_id, json string, and label IDs so callers
 * can parse as needed. Returns null if the OPFS blob cannot be found.
 */
export function listInboxFromDB(
  accountEmail: string,
  listId: string,
  limit: number
): ListInboxRow[] | null {
  const blobPath = findOPFSBlob(accountEmail);
  if (!blobPath) return null;

  const tmpPath = extractSQLite(blobPath);
  try {
    const db = new Database(tmpPath, { readonly: true });
    try {
      const rows = db.query<{ thread_id: string; json: string }>(`
        SELECT t.thread_id, t.json
        FROM threads t
        JOIN list_ids li ON t.thread_id = li.thread_id
        WHERE li.list_id = ?
        ORDER BY t.sort DESC
        LIMIT ?
      `).all(listId, limit);

      if (rows.length === 0) return [];

      // Batch-query list_ids for all returned threads
      const threadIds = rows.map(r => r.thread_id);
      const placeholders = threadIds.map(() => "?").join(",");
      const labelRows = db.query<{ thread_id: string; list_id: string }>(
        `SELECT thread_id, list_id FROM list_ids WHERE thread_id IN (${placeholders})`
      ).all(...threadIds);

      const labelMap = new Map<string, string[]>();
      for (const lr of labelRows) {
        const arr = labelMap.get(lr.thread_id) ?? [];
        arr.push(lr.list_id);
        labelMap.set(lr.thread_id, arr);
      }

      return rows.map(r => ({
        threadId: r.thread_id,
        json: r.json,
        labelIds: labelMap.get(r.thread_id) ?? [],
      }));
    } finally {
      db.close();
    }
  } finally {
    try { rmSync(tmpPath); } catch {}
  }
}
