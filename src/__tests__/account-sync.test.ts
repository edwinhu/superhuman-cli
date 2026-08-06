/**
 * Tests for src/account-sync.ts — multi-account staleness detection + the
 * per-account force-sync trigger (root cause: some accounts' `sync` engine
 * is never `.start()`-ed for the app-session lifetime — see
 * docs/investigations/2026-07-06_multi_account_staleness.md).
 *
 * Two layers:
 *  - `computeFreshness` against an in-memory fixture DB (mirrors the real
 *    `threads`/`messages` schema) — no CDP, no blob extraction.
 *  - `ensureAccountSynced` with injected `getFreshness`/`connect` seams — no
 *    live app needed, mocks the `SyncSession` CDP surface. The same seam
 *    covers both deployment shapes (Chrome-extension service worker and
 *    Electron background_page), since ensureAccountSynced only ever talks to
 *    the backend-agnostic SyncSession.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  computeFreshness,
  ensureAccountSynced,
  type AccountFreshness,
  type EvalResult,
  type SyncSession,
} from "../account-sync";

// ---------------------------------------------------------------------------
// computeFreshness — pure SQL, fixture DB
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE threads (thread_id TEXT, sort INTEGER, json TEXT)`);
  db.run(`CREATE TABLE messages (id TEXT, thread_id TEXT, timestamp INTEGER, is_sent INTEGER)`);
  return db;
}

describe("computeFreshness", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  test("empty tables -> null timestamp, null age, zero counts", () => {
    const f = computeFreshness(db, 1_000_000);
    expect(f.newestTimestampMs).toBeNull();
    expect(f.ageMs).toBeNull();
    expect(f.threadCount).toBe(0);
    expect(f.messageCount).toBe(0);
  });

  test("computes MAX(threads.sort) as the freshness marker and age vs now", () => {
    db.run(`INSERT INTO threads VALUES ('t1', 100, '{}')`);
    db.run(`INSERT INTO threads VALUES ('t2', 500, '{}')`);
    db.run(`INSERT INTO threads VALUES ('t3', 300, '{}')`);
    db.run(`INSERT INTO messages VALUES ('m1', 't1', 100, 0)`);
    db.run(`INSERT INTO messages VALUES ('m2', 't2', 500, 1)`);

    const now = 1_000;
    const f = computeFreshness(db, now);
    expect(f.newestTimestampMs).toBe(500);
    expect(f.ageMs).toBe(500); // now(1000) - 500
    expect(f.threadCount).toBe(3);
    expect(f.messageCount).toBe(2);
  });

  test("stale account: large gap between MAX(sort) and now", () => {
    db.run(`INSERT INTO threads VALUES ('old', ${1_000_000}, '{}')`);
    const now = 1_000_000 + 7 * 24 * 60 * 60 * 1000; // 7 days later
    const f = computeFreshness(db, now);
    expect(f.ageMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// ensureAccountSynced — mocked freshness + SyncSession seams (no live app)
// ---------------------------------------------------------------------------

function makeFreshness(ageMs: number | null): AccountFreshness {
  return {
    newestTimestampMs: ageMs == null ? null : 1000 - ageMs,
    ageMs,
    threadCount: 10,
    messageCount: 20,
  };
}

/**
 * Build a fake SyncSession. `evaluate(email, expr)` receives the *built*
 * expression string (via `build("window.background")`) so tests can branch on
 * `expr.includes("sync.start()")` exactly as they did against the raw CDP
 * evaluate seam.
 */
function fakeSession(
  emails: string[],
  evaluate: (email: string, expr: string) => EvalResult
): SyncSession {
  return {
    kind: "extension",
    emails,
    async evaluateForAccount(email, build) {
      return evaluate(email, build("window.background"));
    },
    async disconnect() {},
  };
}

describe("ensureAccountSynced", () => {
  test("fresh account: short-circuits without connecting over CDP", async () => {
    let connectCalled = false;
    const result = await ensureAccountSynced("fresh@example.com", {
      maxAgeMs: 15 * 60 * 1000,
      getFreshness: () => makeFreshness(60_000), // 1 min old, well under 15 min
      connect: async () => {
        connectCalled = true;
        return null;
      },
    });

    expect(result.synced).toBe(false);
    expect(result.reason).toBe("fresh");
    expect(connectCalled).toBe(false);
  });

  test("stale account with no reachable sync target -> no-connection", async () => {
    const result = await ensureAccountSynced("stale@example.com", {
      getFreshness: () => makeFreshness(999_999_999),
      connect: async () => null,
    });

    expect(result.synced).toBe(false);
    expect(result.reason).toBe("no-connection");
  });

  test("stale account, connected, but this email isn't in the session -> no-context", async () => {
    const session = fakeSession([], () => ({ ok: true, value: null }));
    const result = await ensureAccountSynced("missing@example.com", {
      getFreshness: () => makeFreshness(999_999_999),
      connect: async () => session,
    });

    expect(result.synced).toBe(false);
    expect(result.reason).toBe("no-context");
  });

  test("stale account: calls sync.start(), polls _lastRunEnded until it advances -> synced", async () => {
    let evalCount = 0;
    const session = fakeSession(["stale@example.com"], (_email, expr) => {
      evalCount++;
      if (expr.includes("sync.start()")) {
        // Snapshot call: report a pre-call _lastRunEnded of 1000.
        return { ok: true, value: { ok: true, lastRunEnded: 1000, isStarted: true } };
      }
      // Poll calls: advance past 1000 on the 2nd poll.
      const advanced = evalCount >= 3; // 1 snapshot + 2 polls
      return { ok: true, value: advanced ? 2000 : 1000 };
    });

    const result = await ensureAccountSynced("stale@example.com", {
      getFreshness: () => makeFreshness(999_999_999),
      connect: async () => session,
      pollIntervalMs: 1, // keep the test fast
      timeoutMs: 5000,
    });

    expect(result.synced).toBe(true);
    expect(result.reason).toBe("synced");
  });

  test("stale account: poller never advances within timeout -> timeout", async () => {
    const session = fakeSession(["stuck@example.com"], (_email, expr) => {
      if (expr.includes("sync.start()")) {
        return { ok: true, value: { ok: true, lastRunEnded: 1000, isStarted: true } };
      }
      return { ok: true, value: 1000 }; // never advances
    });

    const result = await ensureAccountSynced("stuck@example.com", {
      getFreshness: () => makeFreshness(999_999_999),
      connect: async () => session,
      pollIntervalMs: 1,
      timeoutMs: 10, // tiny timeout so the test stays fast
    });

    expect(result.synced).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  test("poller shape unreadable (version drift): degrades to a timed wait, doesn't throw", async () => {
    const session = fakeSession(["driftaccount@example.com"], (_email, expr) => {
      if (expr.includes("sync.start()")) {
        // Simulate a renamed/missing poller: lastRunEnded is null.
        return { ok: true, value: { ok: true, lastRunEnded: null, isStarted: true } };
      }
      return { ok: true, value: null };
    });

    const start = Date.now();
    const result = await ensureAccountSynced("driftaccount@example.com", {
      getFreshness: () => makeFreshness(999_999_999),
      connect: async () => session,
      timeoutMs: 50, // degraded wait is capped at min(DEGRADED_WAIT_MS, timeoutMs)
    });
    const elapsed = Date.now() - start;

    expect(result.synced).toBe(true);
    expect(result.reason).toBe("degraded-wait");
    expect(elapsed).toBeGreaterThanOrEqual(40); // waited roughly the capped timeout
  });

  test("eval fails entirely -> error result, doesn't throw", async () => {
    const session = fakeSession(["errors@example.com"], () => ({
      ok: false,
      error: "target closed",
    }));

    const result = await ensureAccountSynced("errors@example.com", {
      getFreshness: () => makeFreshness(999_999_999),
      connect: async () => session,
    });

    expect(result.synced).toBe(false);
    expect(result.reason).toBe("error");
    expect(result.error).toBe("target closed");
  });

  test("force: true bypasses the freshness short-circuit even when fresh", async () => {
    let connected = false;
    const session = fakeSession(["fresh-but-forced@example.com"], (_email, expr) => {
      if (expr.includes("sync.start()")) {
        return { ok: true, value: { ok: true, lastRunEnded: 1, isStarted: true } };
      }
      return { ok: true, value: 2 }; // advances immediately
    });

    const result = await ensureAccountSynced("fresh-but-forced@example.com", {
      force: true,
      getFreshness: () => makeFreshness(60_000), // very fresh
      connect: async () => {
        connected = true;
        return session;
      },
      pollIntervalMs: 1,
    });

    expect(connected).toBe(true);
    expect(result.synced).toBe(true);
    expect(result.reason).toBe("synced");
  });

  test("no on-disk blob yet (getFreshness returns null) still attempts a sync", async () => {
    const session = fakeSession(["neverseen@example.com"], (_email, expr) => {
      if (expr.includes("sync.start()")) {
        return { ok: true, value: { ok: true, lastRunEnded: 1, isStarted: true } };
      }
      return { ok: true, value: 2 };
    });

    const result = await ensureAccountSynced("neverseen@example.com", {
      getFreshness: () => null,
      connect: async () => session,
      pollIntervalMs: 1,
    });

    expect(result.before).toBeNull();
    expect(result.reason).toBe("synced");
  });
});
