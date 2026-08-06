/**
 * Multi-Account Sync Staleness — force-sync + freshness detection
 *
 * Root cause (see docs/investigations/2026-07-06_multi_account_staleness.md):
 * Superhuman runs one background-sync engine per linked account, but that
 * engine is only `.start()`-ed on account activation/foreground-switch — NOT
 * unconditionally for every linked account at app boot. An account that was
 * linked before the last app restart but never made active in this session can
 * have its `sync._isStarted === false` indefinitely, so its local OPFS SQLite
 * cache (the thing `sqlite-search.ts` reads for `inbox`/`search`/`read`) goes
 * stale or stays empty — silently, with no error, just 0 results.
 *
 * Two deployment shapes expose that per-account engine differently, and this
 * module abstracts over both via `SyncSession` (see connectSyncSession):
 *
 *  - **Chrome-extension** (Linux/omarchy, and any Chromium where Superhuman
 *    runs as the MV3 extension): the sync engine lives in the extension's
 *    service worker, one per account, reachable as
 *    `backgrounds[email]._accountBackground.di.get("sync")`. There is a single
 *    service-worker execution context; the account is selected by keying into
 *    `backgrounds[email]`.
 *  - **Electron app** (macOS/Windows desktop Superhuman.app): the engine lives
 *    in the hidden `background_page.html`, one per-account iframe, reachable as
 *    `window.background.di.get("sync")` in that iframe's execution context. The
 *    account is selected by CDP `contextId`.
 *
 * This module provides:
 *  - `getAccountFreshness(email)` — a pure on-disk staleness check (no CDP),
 *    reading `MAX(threads.sort)` (== `MAX(messages.timestamp)`) from the
 *    account's OPFS SQLite blob.
 *  - `ensureAccountSynced(email, opts)` — checks freshness; if stale (or
 *    `force`), opens a `SyncSession` (extension first, Electron fallback),
 *    calls `sync.start()` in that account's context (idempotent,
 *    side-effect-free beyond kicking off the normal poll loop — confirmed by
 *    reading its minified source), and awaits one completed poll cycle via
 *    `sync._pollers.syncForward._lastRunEnded` before returning.
 *
 * Fragility note: `sync`, `_pollers`, `_lastRunEnded`, `forceSyncBackend`,
 * `backgrounds`, `_accountBackground` are minified/private Superhuman
 * internals — NOT a public API. A Superhuman update could rename or restructure
 * them at any time. Every access is wrapped in try/catch; if the poller shape
 * can't be read, this degrades gracefully to a fixed timed wait rather than
 * throwing.
 */
import { Database } from "bun:sqlite";
import { rmSync } from "fs";
import { findOPFSBlob, extractSQLite } from "./sqlite-search";
import {
  connectToBackgroundPage,
  disconnectBackgroundPage,
  type BgPageConn,
} from "./background-page-refresh";
import {
  connectToSuperhumanChrome,
  disconnectChrome,
  getCDPPort,
  type ChromeExtConnection,
} from "./superhuman-api";

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

// ---------------------------------------------------------------------------
// SyncSession — backend-agnostic per-account CDP eval surface
// ---------------------------------------------------------------------------

/** Result of a single per-account eval. */
export type EvalResult = { ok: true; value: any } | { ok: false; error: string };

/**
 * A per-account CDP eval session. Abstracts the two deployment shapes:
 * the Chrome-extension service worker (account keyed by `backgrounds[email]`)
 * and the Electron background_page (account selected by iframe `contextId`).
 * Callers express what to run as a builder over `bg` — a JS expression string
 * that resolves to the account's background object (exposing `.di`).
 */
export interface SyncSession {
  /** Which deployment backs this session (diagnostics only). */
  readonly kind: "extension" | "electron";
  /** Emails this session can sync (ground truth for "what's linked" now). */
  readonly emails: string[];
  /**
   * Evaluate `build(bg)` for `email`, where `bg` is a JS expression resolving
   * to that account's background object. Returns the by-value result, or an
   * `{ ok: false }` if the account isn't present / the eval threw.
   */
  evaluateForAccount(
    email: string,
    build: (bg: string) => string,
    awaitPromise?: boolean
  ): Promise<EvalResult>;
  disconnect(): Promise<void>;
}

/** Wrap a live Electron background_page connection as a SyncSession. */
export function electronSession(conn: BgPageConn): SyncSession {
  return {
    kind: "electron",
    emails: Array.from(conn.contextByEmail.keys()),
    async evaluateForAccount(email, build, awaitPromise = false) {
      const contextId = conn.contextByEmail.get(email);
      if (contextId === undefined) return { ok: false, error: "no-context" };
      try {
        const r = await conn.client.Runtime.evaluate({
          expression: build("window.background"),
          returnByValue: true,
          awaitPromise,
          contextId,
        });
        if ((r as any)?.exceptionDetails) {
          const ed = (r as any).exceptionDetails;
          return { ok: false, error: ed.exception?.description ?? ed.text ?? "eval error" };
        }
        return { ok: true, value: r?.result?.value ?? null };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
    async disconnect() {
      await disconnectBackgroundPage(conn);
    },
  };
}

/** Wrap a live Chrome-extension service-worker connection as a SyncSession. */
export function extensionSession(conn: ChromeExtConnection, emails: string[]): SyncSession {
  return {
    kind: "extension",
    emails,
    async evaluateForAccount(email, build, awaitPromise = false) {
      // Resolve the per-account background inside the single SW context.
      const key = JSON.stringify(email);
      const bg = `(typeof backgrounds!=="undefined"&&backgrounds[${key}]?._accountBackground)`;
      try {
        const r = await conn.swClient.Runtime.evaluate({
          expression: build(bg),
          returnByValue: true,
          awaitPromise,
        });
        if (r.exceptionDetails) {
          return {
            ok: false,
            error:
              r.exceptionDetails.exception?.description ??
              r.exceptionDetails.text ??
              "eval error",
          };
        }
        return { ok: true, value: r?.result?.value ?? null };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
    async disconnect() {
      await disconnectChrome(conn);
    },
  };
}

/**
 * Open a SyncSession, preferring the Chrome-extension service worker (the
 * common shape on Linux/omarchy, where there is no Superhuman.app) and falling
 * back to the Electron background_page (macOS/Windows desktop app). Returns
 * null when neither exposes a Superhuman sync target.
 */
export async function connectSyncSession(port?: number): Promise<SyncSession | null> {
  const p = port ?? getCDPPort();

  // Extension first: read the SW's `backgrounds` map to enumerate accounts.
  const ext = await connectToSuperhumanChrome(p);
  if (ext) {
    let emails: string[] = [];
    try {
      const r = await ext.swClient.Runtime.evaluate({
        expression: `typeof backgrounds!=="undefined"?Object.keys(backgrounds):[]`,
        returnByValue: true,
      });
      emails = (r?.result?.value as string[]) ?? [];
    } catch {
      emails = [];
    }
    if (emails.length > 0) return extensionSession(ext, emails);
    // Extension target present but no accounts wired up — release it and try
    // the Electron path rather than returning an empty session.
    await disconnectChrome(ext);
  }

  // Electron fallback: the hidden background_page with per-account iframes.
  const bg = await connectToBackgroundPage(p);
  if (bg) return electronSession(bg);

  return null;
}

export type EnsureSyncReason =
  | "fresh" // freshness marker was already within maxAgeMs; nothing done
  | "no-connection" // no Superhuman sync target reachable over CDP
  | "no-context" // session reachable but this account isn't present in it
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
  /** Test seam: override session creation. Defaults to connectSyncSession. */
  connect?: (port?: number) => Promise<SyncSession | null>;
  /**
   * Test seam / caller-shared session: if given, this session is used as-is and
   * is NOT disconnected by this call (caller owns its lifecycle) — lets
   * `syncAllAccounts` share one CDP connection across multiple accounts.
   */
  session?: SyncSession;
}

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Fallback wait when the poller shape can't be read at all (degraded mode). */
const DEGRADED_WAIT_MS = 10_000;

/**
 * Snapshot the pre-sync `_lastRunEnded` and kick `sync.start()`. `bg` resolves
 * to the account's background object (`window.background` on Electron,
 * `backgrounds[email]._accountBackground` on the extension).
 */
const snapshotExpr = (bg: string) => `
  (() => {
    try {
      const _bg = ${bg};
      if (!_bg) return { ok: false, error: "no background for account" };
      const sync = _bg.di && _bg.di.get && _bg.di.get("sync");
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

const forceSyncExpr = (bg: string) => `
  (() => {
    try {
      const _bg = ${bg};
      const sync = _bg && _bg.di && _bg.di.get && _bg.di.get("sync");
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

const pollExpr = (bg: string) => `
  (() => {
    try {
      const _bg = ${bg};
      const sync = _bg && _bg.di && _bg.di.get && _bg.di.get("sync");
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
  const connectFn = opts.connect ?? ((port?: number) => connectSyncSession(port));

  const before = getFreshness(email);

  if (!opts.force && before?.ageMs != null && before.ageMs < maxAgeMs) {
    return { synced: false, reason: "fresh", before, after: before, waitedMs: 0 };
  }

  const ownSession = !opts.session;
  const session = opts.session ?? (await connectFn(opts.port));
  if (!session) {
    return { synced: false, reason: "no-connection", before, after: before, waitedMs: 0 };
  }

  const start = Date.now();
  try {
    if (!session.emails.includes(email)) {
      return { synced: false, reason: "no-context", before, after: before, waitedMs: 0 };
    }

    const snapRes = await session.evaluateForAccount(email, snapshotExpr);
    if (!snapRes.ok) {
      return {
        synced: false,
        reason: "error",
        before,
        after: before,
        waitedMs: Date.now() - start,
        error: snapRes.error,
      };
    }

    const snap = snapRes.value as
      | { ok: boolean; error?: string; lastRunEnded: number | null }
      | null;

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
      // forceSyncBackend is a best-effort escalation lever; ignore failures and
      // fall through to the normal poller-wait below.
      await session.evaluateForAccount(email, forceSyncExpr).catch(() => {});
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
      const poll = await session.evaluateForAccount(email, pollExpr);
      if (!poll.ok) {
        // Eval failed mid-poll (e.g. context torn down) — stop polling and
        // fall through to the timeout/degraded-wait handling below.
        break;
      }
      const current = poll.value;
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
    if (ownSession) await session.disconnect();
  }
}

/**
 * Enumerate every account exposed by the live session (active or not) — the
 * ground truth for "what's linked", since it reflects the running app rather
 * than a possibly-incomplete on-disk blob scan. Returns [] if no Superhuman
 * sync target is reachable over CDP.
 */
export async function listSyncableAccounts(port?: number): Promise<string[]> {
  const session = await connectSyncSession(port);
  if (!session) return [];
  try {
    return session.emails;
  } finally {
    await session.disconnect();
  }
}

/**
 * Sync every linked account, sharing a single CDP session across all of them
 * (opened once via connectSyncSession, reused for each account's
 * ensureAccountSynced call, closed once at the end).
 */
export async function syncAllAccounts(
  opts: Omit<EnsureSyncOptions, "session"> = {}
): Promise<Map<string, EnsureSyncResult>> {
  const results = new Map<string, EnsureSyncResult>();
  const connectFn = opts.connect ?? ((port?: number) => connectSyncSession(port));
  const session = await connectFn(opts.port);
  if (!session) return results;

  try {
    for (const email of session.emails) {
      results.set(email, await ensureAccountSynced(email, { ...opts, session }));
    }
  } finally {
    await session.disconnect();
  }
  return results;
}
