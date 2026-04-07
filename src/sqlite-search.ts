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
function extractSQLite(blobPath: string): string {
  const { readFileSync } = require("fs");
  const data = readFileSync(blobPath) as Buffer;
  const sqliteData = data.slice(OPFS_HEADER_SIZE);

  const tmpPath = join(tmpdir(), `superhuman-search-${Date.now()}.sqlite3`);
  writeFileSync(tmpPath, sqliteData);
  return tmpPath;
}

export interface DirectSearchOptions {
  query: string;
  limit?: number;
  accountEmail: string;
}

/**
 * Search the Superhuman SQLite FTS3 index directly from the OPFS blob on disk.
 * No CDP or browser connection required.
 *
 * Returns InboxThread[] sorted by message date descending, or null if the
 * OPFS blob cannot be found for this account.
 */
export async function searchDirect(options: DirectSearchOptions): Promise<InboxThread[] | null> {
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
// FTS query helpers
// ---------------------------------------------------------------------------

function escapeFtsToken(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function buildMatchExpr(queryStr: string): string {
  const words = queryStr.trim().split(/\s+/).filter(Boolean);
  return words.map(escapeFtsToken).join(" ");
}

function queryFTS(dbPath: string, queryStr: string, limit: number): InboxThread[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const matchExpr = buildMatchExpr(queryStr);

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
      WHERE thread_search MATCH ?
      ORDER BY t.sort DESC
      LIMIT ?
    `).all(matchExpr, limit);

    // Build a set of thread_ids for a single batch list_ids query
    const threadIds = rows.map(r => r.thread_id);
    const labelMap = new Map<string, string[]>();
    if (threadIds.length > 0) {
      const placeholders = threadIds.map(() => "?").join(",");
      const labelRows = db.query<{ thread_id: string; list_id: string }>(
        `SELECT thread_id, list_id FROM list_ids WHERE thread_id IN (${placeholders})`
      ).all(...threadIds);
      for (const lr of labelRows) {
        const arr = labelMap.get(lr.thread_id) ?? [];
        arr.push(lr.list_id);
        labelMap.set(lr.thread_id, arr);
      }
    }

    const threads = rows.map((row): InboxThread | null => {
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

    // Sort by date descending
    threads.sort(
      (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
    );

    return threads;
  } finally {
    db.close();
  }
}

function parseFromStr(from: string): { email: string; name: string } {
  const match = from.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from, name: from };
}
