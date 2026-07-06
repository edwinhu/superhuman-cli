/**
 * Multi-Account Sync Staleness — force-sync + freshness detection
 *
 * Root cause (see docs/investigations/2026-07-06_multi_account_staleness.md):
 * Superhuman runs one background-sync engine per linked account inside the
 * Electron app's hidden `background_page.html`, but that engine is only
 * `.start()`-ed on account activation/foreground-switch — NOT unconditionally
 * for every linked account at app boot. An account that was linked before the
 * last app restart but never made active in this session can have its
 * `sync._isStarted === false` indefinitely, so its local OPFS SQLite cache
 * (the thing `sqlite-search.ts` reads for `inbox`/`search`/`read`) goes stale
 * or stays empty — silently, with no error, just 0 results.
 *
 * This module provides:
 *  - `getAccountFreshness(email)` — a pure on-disk staleness check (no CDP),
 *    reading `MAX(threads.sort)` (== `MAX(messages.timestamp)`) from the
 *    account's OPFS SQLite blob.
 *  - `ensureAccountSynced(email, opts)` — checks freshness; if stale (or
 *    `force`), connects to the background_page over CDP (reusing the
 *    `connectToBackgroundPage()` plumbing from background-page-refresh.ts),
 *    calls `sync.start()` in that account's iframe execution context
 *    (idempotent, side-effect-free beyond kicking off the normal poll loop —
 *    confirmed by reading its minified source), and awaits one completed
 *    poll cycle via `sync._pollers.syncForward._lastRunEnded` before
 *    returning.
 *
 * Fragility note: `sync`, `_pollers`, `_lastRunEnded`, `forceSyncBackend` are
 * minified/private Superhuman internals — NOT a public API. A Superhuman
 * update could rename or restructure them at any time. Every access is
 * wrapped in try/catch; if the poller shape can't be read, this degrades
 * gracefully to a fixed timed wait rather than throwing.
 */
import { Database } from "bun:sqlite";
import { rmSync } from "fs";
import { findOPFSBlob, extractSQLite } from "./sqlite-search";
import {
  connectToBackgroundPage,
  disconnectBackgroundPage,
  type BgPageConn,
} from "./background-page-refresh";

export interface AccountFreshness {
  /** MAX(threads.sort) — ms epoch of the newest cached thread activity, or null if the table is empty/unreadable. */
  newestTimestampMs: number | null;
  /** now - newestTimestampMs, or null when newestTimestampMs is null. */
  ageMs: number | null;
  threadCount: number;
  messageCount: number;
}

/**
 * Pure freshness computation against an already-open SQLite connection.
 * Separated from blob acquisition so this half is unit-testable against an
 * in-memory fixture DB (see src/__tests__/account-sync.test.ts).
 */
export function computeFreshness(db: Database, nowMs: number = Date.now()): AccountFreshness {
  let threadCount = 0;
  let newestTimestampMs: number | null = null;
  try {
    const row = db
      .query<{ maxSort: number | null; cnt: number }, []>(
        `SELECT MAX(sort) AS maxSort, COUNT(*) AS cnt FROM threads`
      )
      .get();
    threadCount = row?.cnt ?? 0;
    newestTimestampMs = row?.maxSort ?? null;
  } catch {
    // Table missing/unreadable — treat as "no data".
  }

  let messageCount = 0;
  try {
    const row = db.query<{ cnt: number }, []>(`SELECT COUNT(*) AS cnt FROM messages`).get();
    messageCount = row?.cnt ?? 0;
  } catch {
    // Table missing/unreadable — treat as "no data".
  }

  return {
    newestTimestampMs,
    ageMs: newestTimestampMs != null ? nowMs - newestTimestampMs : null,
    threadCount,
    messageCount,
  };
}

/**
 * Read on-disk freshness for an account's local OPFS SQLite cache. No CDP
 * connection required — pure filesystem + SQLite read. Returns null when no
 * blob exists for this account at all (never synced even once).
 */
export function getAccountFreshness(
  email: string,
  nowMs: number = Date.now()
): AccountFreshness | null {
  const blobPath = findOPFSBlob(email);
  if (!blobPath) return null;

  const tmpPath = extractSQLite(blobPath);
  try {
    const db = new Database(tmpPath, { readonly: true });
    try {
      return computeFreshness(db, nowMs);
    } finally {
      db.close();
    }
  } finally {
    try {
      rmSync(tmpPath);
    } catch {}
  }
}

export type EnsureSyncReason =
  | "fresh" // freshness marker was already within maxAgeMs; nothing done
  | "no-connection" // background_page unreachable (app not running w/ CDP)
  | "no-context" // background_page reachable but this account has no iframe
  | "synced" // sync.start() called + a poll cycle was observed completing
  | "timeout" // sync.start() called but no completed cycle observed in time
  | "degraded-wait" // poller internals unreadable; fell back to a fixed wait
  | "error"; // an eval threw / returned an error

export interface EnsureSyncResult {
  /** Whether we actually triggered/awaited a sync (false for the "fresh" short-circuit). */
  synced: boolean;
  reason: EnsureSyncReason;
  before: AccountFreshness | null;
  after: AccountFreshness | null;
  waitedMs: number;
  error?: string;
}

export interface EnsureSyncOptions {
  /** Skip syncing if the on-disk freshness marker is newer than this. Default 15 min. */
  maxAgeMs?: number;
  /** Safety ceiling for awaiting a completed poll cycle. Default 90s. */
  timeoutMs?: number;
  /** Poll interval while awaiting completion. Default 2s. */
  pollIntervalMs?: number;
  /** Skip the freshness short-circuit and always trigger sync + also call forceSyncBackend(). */
  force?: boolean;
  port?: number;
  /** Test seam: override freshness lookup. Defaults to getAccountFreshness. */
  getFreshness?: (email: string, nowMs?: number) => AccountFreshness | null;
  /** Test seam: override background_page connection. Defaults to connectToBackgroundPage. */
  connect?: (port?: number) => Promise<BgPageConn | null>;
  /**
   * Test seam / caller-shared connection: if given, this connection is used
   * as-is and is NOT disconnected by this call (caller owns its lifecycle) —
   * lets `syncAllAccounts` share one CDP connection across multiple accounts.
   */
  conn?: BgPageConn;
}

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Fallback wait when the poller shape can't be read at all (degraded mode). */
const DEGRADED_WAIT_MS = 10_000;

const SNAPSHOT_EXPR = `
  (() => {
    try {
      const bg = window.background;
      if (!bg) return { ok: false, error: "no window.background" };
      const sync = bg.di && bg.di.get && bg.di.get("sync");
      if (!sync) return { ok: false, error: "no sync service" };
      const lastRunEnded = sync._pollers && sync._pollers.syncForward
        ? sync._pollers.syncForward._lastRunEnded
        : null;
      sync.start();
      return { ok: true, lastRunEnded: typeof lastRunEnded === "number" ? lastRunEnded : null, isStarted: !!sync._isStarted };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  })()
`;

const FORCE_SYNC_EXPR = `
  (() => {
    try {
      const sync = window.background && window.background.di && window.background.di.get && window.background.di.get("sync");
      if (sync && typeof sync.forceSyncBackend === "function") {
        sync.forceSyncBackend();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  })()
`;

const POLL_EXPR = `
  (() => {
    try {
      const sync = window.background && window.background.di && window.background.di.get && window.background.di.get("sync");
      const v = sync && sync._pollers && sync._pollers.syncForward ? sync._pollers.syncForward._lastRunEnded : null;
      return typeof v === "number" ? v : null;
    } catch {
      return null;
    }
  })()
`;

/**
 * Ensure a specific account's local OPFS SQLite cache is fresh. Checks the
 * on-disk freshness marker first (cheap, no CDP); only connects over CDP and
 * triggers `sync.start()` when the marker is stale (or `force` is set).
 *
 * Never switches the visible/active account. Never drives the UI. Safe to
 * call unconditionally before a local-cache read.
 */
export async function ensureAccountSynced(
  email: string,
  opts: EnsureSyncOptions = {}
): Promise<EnsureSyncResult> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const getFreshness = opts.getFreshness ?? ((e: string, n?: number) => getAccountFreshness(e, n));
  const connectFn = opts.connect ?? ((port?: number) => connectToBackgroundPage(port));

  const before = getFreshness(email);

  if (!opts.force && before?.ageMs != null && before.ageMs < maxAgeMs) {
    return { synced: false, reason: "fresh", before, after: before, waitedMs: 0 };
  }

  const ownConn = !opts.conn;
  const conn = opts.conn ?? (await connectFn(opts.port));
  if (!conn) {
    return { synced: false, reason: "no-connection", before, after: before, waitedMs: 0 };
  }

  const start = Date.now();
  try {
    const contextId = conn.contextByEmail.get(email);
    if (contextId === undefined) {
      return { synced: false, reason: "no-context", before, after: before, waitedMs: 0 };
    }

    let snap: { ok: boolean; error?: string; lastRunEnded: number | null } | null = null;
    try {
      const r = await conn.client.Runtime.evaluate({
        expression: SNAPSHOT_EXPR,
        returnByValue: true,
        contextId,
      });
      snap = r?.result?.value ?? null;
    } catch (e: any) {
      return {
        synced: false,
        reason: "error",
        before,
        after: before,
        waitedMs: Date.now() - start,
        error: e?.message,
      };
    }

    if (!snap || snap.ok === false) {
      return {
        synced: false,
        reason: "error",
        before,
        after: before,
        waitedMs: Date.now() - start,
        error: snap?.error ?? "unknown eval failure",
      };
    }

    if (opts.force) {
      try {
        await conn.client.Runtime.evaluate({
          expression: FORCE_SYNC_EXPR,
          returnByValue: true,
          contextId,
        });
      } catch {
        // forceSyncBackend is a best-effort escalation lever; ignore failures
        // and fall through to the normal poller-wait below.
      }
    }

    const lastRunBefore = snap.lastRunEnded;

    // Poller internals unreadable (version drift) — degrade to a fixed wait
    // rather than guessing at a renamed/restructured shape.
    if (lastRunBefore == null) {
      await new Promise((r) => setTimeout(r, Math.min(DEGRADED_WAIT_MS, timeoutMs)));
      const after = getFreshness(email);
      return { synced: true, reason: "degraded-wait", before, after, waitedMs: Date.now() - start };
    }

    const deadline = start + timeoutMs;
    let advanced = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      let current: number | null = null;
      try {
        const poll = await conn.client.Runtime.evaluate({
          expression: POLL_EXPR,
          returnByValue: true,
          contextId,
        });
        current = poll?.result?.value ?? null;
      } catch {
        // Eval failed mid-poll (e.g. context torn down) — stop polling and
        // fall through to the timeout/degraded-wait handling below.
        break;
      }
      if (typeof current === "number" && current > lastRunBefore) {
        advanced = true;
        break;
      }
    }

    const after = getFreshness(email);
    const waitedMs = Date.now() - start;
    return {
      synced: advanced,
      reason: advanced ? "synced" : "timeout",
      before,
      after,
      waitedMs,
    };
  } finally {
    if (ownConn) await disconnectBackgroundPage(conn);
  }
}

/**
 * Enumerate every account exposed by the background_page's per-account
 * iframes (active or not) — the ground truth for "what's linked", since it
 * reflects the live Electron session rather than a possibly-incomplete
 * on-disk blob scan. Returns [] if the background_page isn't reachable.
 */
export async function listSyncableAccounts(port?: number): Promise<string[]> {
  const conn = await connectToBackgroundPage(port);
  if (!conn) return [];
  try {
    return Array.from(conn.contextByEmail.keys());
  } finally {
    await disconnectBackgroundPage(conn);
  }
}

/**
 * Sync every linked account, sharing a single CDP connection across all of
 * them (opened once via connectToBackgroundPage, reused for each account's
 * ensureAccountSynced call, closed once at the end).
 */
export async function syncAllAccounts(
  opts: Omit<EnsureSyncOptions, "conn"> = {}
): Promise<Map<string, EnsureSyncResult>> {
  const results = new Map<string, EnsureSyncResult>();
  const connectFn = opts.connect ?? ((port?: number) => connectToBackgroundPage(port));
  const conn = await connectFn(opts.port);
  if (!conn) return results;

  try {
    for (const email of conn.contextByEmail.keys()) {
      results.set(email, await ensureAccountSynced(email, { ...opts, conn }));
    }
  } finally {
    await disconnectBackgroundPage(conn);
  }
  return results;
}
