/**
 * Tests for inbox.ts using SuperhumanProvider (backend API path).
 *
 * Inbox listing now uses portal RPC (threadInternal.listAsync) when a CDP
 * connection is available. Without portal, inbox requests throw a helpful
 * error. Non-inbox data (snippets, reminders) still uses backendFetch.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { SuperhumanProvider } from "../superhuman-provider";
import type { SuperhumanTokenInfo } from "../superhuman-provider";
import { listInbox, searchInbox, streamListInbox, type InboxThread } from "../inbox";

const sampleToken: SuperhumanTokenInfo = {
  token: "test-jwt-token",
  email: "user@example.com",
  accountId: "acct_123",
  expires: Date.now() + 3600_000,
};

/** Build a fake portal listAsync result (array of thread objects) */
function makePortalListResult(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `thread_${i}`,
    threadId: `thread_${i}`,
    subject: `Subject ${i}`,
    from: `sender${i}@example.com`,
    date: `2026-03-${String(20 + i).padStart(2, "0")}T12:00:00Z`,
    snippet: `Preview text for thread ${i}`,
    labelIds: ["INBOX", ...(i === 0 ? ["UNREAD"] : [])],
    messageCount: 2,
  }));
}

/** Build a fake getThreads response with N threads (for non-inbox data) */
function makeGetThreadsResponse(count: number) {
  const threadList = Array.from({ length: count }, (_, i) => ({
    thread: {
      historyId: `hist_${i}`,
      messages: {
        [`msg_${i}_a`]: {
          id: `msg_${i}_a`,
          subject: `Subject ${i}`,
          from: `sender${i}@example.com`,
          to: ["user@example.com"],
          date: `2026-03-${String(20 + i).padStart(2, "0")}T12:00:00Z`,
          snippet: `Preview text for thread ${i}`,
          labelIds: ["INBOX", ...(i === 0 ? ["UNREAD"] : [])],
        },
        [`msg_${i}_b`]: {
          id: `msg_${i}_b`,
          subject: `Re: Subject ${i}`,
          from: `other${i}@example.com`,
          to: ["user@example.com"],
          date: `2026-03-${String(21 + i).padStart(2, "0")}T14:00:00Z`,
          snippet: `Reply preview for thread ${i}`,
          labelIds: ["INBOX"],
        },
      },
      reminder: null,
    },
  }));
  return { threadList };
}

/**
 * Create a SuperhumanProvider with a mock portal (CDP connection).
 * The portalInvoke mock is returned so tests can inspect calls.
 */
function createProviderWithPortal(portalResult: any) {
  const provider = new SuperhumanProvider(sampleToken);
  const portalMock = mock(() => Promise.resolve(portalResult));
  // Monkey-patch hasPortal and portalInvoke
  (provider as any).hasPortal = () => true;
  (provider as any).portalInvoke = portalMock;
  return { provider, portalMock };
}

describe("inbox with SuperhumanProvider (portal path)", () => {
  test("listInbox uses portalInvoke for INBOX listing", async () => {
    const portalResult = makePortalListResult(3);
    const { provider, portalMock } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { limit: 10 });

    expect(portalMock).toHaveBeenCalledTimes(1);
    const [service, method, args] = portalMock.mock.calls[0] as any[];
    expect(service).toBe("threadInternal");
    expect(method).toBe("listAsync");
    expect(args[0]).toBe("INBOX");
    expect(args[1].limit).toBe(10);
    expect(threads).toHaveLength(3);
  });

  test("splitInbox 'important' uses portalInvoke with SH_IMPORTANT", async () => {
    const { provider, portalMock } = createProviderWithPortal(makePortalListResult(1));

    await listInbox(provider, { splitInbox: "important", limit: 5 });

    const args = (portalMock.mock.calls[0] as any[])[2];
    expect(args[0]).toBe("SH_IMPORTANT");
    expect(args[1].limit).toBe(5);
  });

  test("splitInbox 'other' uses portalInvoke with SH_OTHER", async () => {
    const { provider, portalMock } = createProviderWithPortal(makePortalListResult(1));

    await listInbox(provider, { splitInbox: "other", limit: 5 });

    const args = (portalMock.mock.calls[0] as any[])[2];
    expect(args[0]).toBe("SH_OTHER");
  });

  test("default limit is 10 when not specified", async () => {
    const { provider, portalMock } = createProviderWithPortal(makePortalListResult(1));

    await listInbox(provider);

    const args = (portalMock.mock.calls[0] as any[])[2];
    expect(args[1].limit).toBe(10);
  });

  test("parses portal result into InboxThread format", async () => {
    const portalResult = makePortalListResult(1);
    const { provider } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { limit: 10 });

    expect(threads).toHaveLength(1);
    const t = threads[0];
    expect(t.id).toBe("thread_0");
    expect(t.subject).toBe("Subject 0");
    expect(t.from.email).toBe("sender0@example.com");
    expect(t.date).toBeTruthy();
    expect(t.snippet).toBeTruthy();
    expect(t.labelIds).toBeArray();
    expect(t.messageCount).toBe(2);
  });

  test("handles empty portal result", async () => {
    const { provider } = createProviderWithPortal([]);

    const threads = await listInbox(provider);
    expect(threads).toEqual([]);
  });

  test("unreadOnly filter applied client-side on portal results", async () => {
    const portalResult = makePortalListResult(3); // only index 0 has UNREAD
    const { provider } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { unreadOnly: true, limit: 10 });

    expect(threads).toHaveLength(1);
    expect(threads[0].labelIds).toContain("UNREAD");
  });

  test("parses to/cc recipients of the latest message (string and object forms)", async () => {
    const portalResult = [{
      id: "t1", threadId: "t1", subject: "Hi", date: "2026-03-20T12:00:00Z",
      from: { email: "sender@example.com", name: "Sender" },
      to: [{ email: "user@example.com", name: "User" }],
      cc: ["Bob <bob@example.com>", { email: "carol@example.com", name: "Carol" }],
      snippet: "s", labelIds: ["INBOX"], messageCount: 1,
    }];
    const { provider } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { limit: 10 });

    expect(threads[0].to).toEqual([{ email: "user@example.com", name: "User" }]);
    expect(threads[0].cc).toEqual([
      { email: "bob@example.com", name: "Bob" },
      { email: "carol@example.com", name: "Carol" },
    ]);
  });

  test("to/cc default to empty arrays when the message omits them", async () => {
    const { provider } = createProviderWithPortal(makePortalListResult(1));
    const threads = await listInbox(provider, { limit: 10 });
    expect(threads[0].to).toEqual([]);
    expect(threads[0].cc).toEqual([]);
  });

  test("aiLabel filter keeps only threads carrying the AI label (short name)", async () => {
    const portalResult = [
      { id: "t0", threadId: "t0", subject: "Reply me", from: "a@example.com",
        date: "2026-03-20T12:00:00Z", snippet: "s", messageCount: 1,
        labelIds: ["INBOX", "Respond (Superhuman/AI)"] },
      { id: "t1", threadId: "t1", subject: "A newsletter", from: "b@example.com",
        date: "2026-03-21T12:00:00Z", snippet: "s", messageCount: 1,
        labelIds: ["INBOX", "News (Superhuman/AI)"] },
      { id: "t2", threadId: "t2", subject: "Plain", from: "c@example.com",
        date: "2026-03-22T12:00:00Z", snippet: "s", messageCount: 1,
        labelIds: ["INBOX"] },
    ];
    const { provider } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { aiLabel: "Respond", limit: 10 });

    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("t0");
  });

  test("aiLabel filter accepts comma-separated list (any-of) and full label strings", async () => {
    const portalResult = [
      { id: "t0", threadId: "t0", subject: "Reply me", from: "a@example.com",
        date: "2026-03-20T12:00:00Z", snippet: "s", messageCount: 1,
        labelIds: ["INBOX", "Respond (Superhuman/AI)"] },
      { id: "t1", threadId: "t1", subject: "Schedule", from: "b@example.com",
        date: "2026-03-21T12:00:00Z", snippet: "s", messageCount: 1,
        labelIds: ["INBOX", "Meeting (Superhuman/AI)"] },
      { id: "t2", threadId: "t2", subject: "News", from: "c@example.com",
        date: "2026-03-22T12:00:00Z", snippet: "s", messageCount: 1,
        labelIds: ["INBOX", "News (Superhuman/AI)"] },
    ];
    const { provider } = createProviderWithPortal(portalResult);

    const shortNames = await listInbox(provider, { aiLabel: "Respond, Meeting", limit: 10 });
    expect(shortNames.map((t) => t.id).sort()).toEqual(["t0", "t1"]);

    const fullString = await listInbox(provider, { aiLabel: "Meeting (Superhuman/AI)", limit: 10 });
    expect(fullString.map((t) => t.id)).toEqual(["t1"]);
  });

  test("streamListInbox yields threads one by one", async () => {
    const { provider } = createProviderWithPortal(makePortalListResult(3));

    const collected: InboxThread[] = [];
    for await (const thread of streamListInbox(provider, { limit: 10 })) {
      collected.push(thread);
    }
    expect(collected).toHaveLength(3);
  });

  test("from field parses 'Name <email>' format", async () => {
    const portalResult = [{
      id: "t1",
      subject: "Test",
      from: "Alice Smith <alice@example.com>",
      date: "2026-03-31T12:00:00Z",
      snippet: "Hello",
      labelIds: ["INBOX"],
      messageCount: 1,
    }];
    const { provider } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { limit: 10 });

    expect(threads[0].from.email).toBe("alice@example.com");
    expect(threads[0].from.name).toBe("Alice Smith");
  });

  // --- needs-reply / me-last detection -------------------------------------
  //
  // Real portal threads arrive in the { json: { id, messages: [...] } } shape.
  // me-last is determined by the LATEST message's SENT label, which Superhuman
  // applies to anything the owner sent from ANY alias — so a reply from an
  // alias that differs from the active account address is still recognized.

  /** Build a portal thread in the real { json } shape from a list of messages. */
  function jsonThread(id: string, messages: any[]) {
    return { json: { id, messages }, listIds: ["INBOX"] };
  }

  test("needs-reply EXCLUDES a thread whose last message the owner sent from an ALIAS", async () => {
    // Active account is user@example.com; the owner replied last from an alias
    // (owner-alias@other.org). Old logic compared from.email to the account
    // address only and leaked this thread; the SENT label catches it.
    const portalResult = [
      jsonThread("leak-alias", [
        { id: "m1", subject: "Q", from: { email: "them@x.com", name: "Them" },
          date: "2026-03-20T10:00:00Z", labelIds: ["INBOX"] },
        { id: "m2", subject: "Re: Q", from: { email: "owner-alias@other.org", name: "Owner" },
          date: "2026-03-20T11:00:00Z", labelIds: ["SENT"] },
      ]),
    ];
    const { provider } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { needsReply: true, limit: 10 });

    expect(threads).toHaveLength(0);
  });

  test("needs-reply INCLUDES a thread whose last message the other person sent", async () => {
    const portalResult = [
      jsonThread("awaiting", [
        { id: "m1", subject: "Q", from: { email: "owner-alias@other.org", name: "Owner" },
          date: "2026-03-20T10:00:00Z", labelIds: ["SENT"] },
        { id: "m2", subject: "Re: Q", from: { email: "them@x.com", name: "Them" },
          date: "2026-03-20T11:00:00Z", labelIds: ["INBOX"] },
      ]),
    ];
    const { provider } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { needsReply: true, limit: 10 });

    expect(threads).toHaveLength(1);
    expect(threads[0].isFromMe).toBe(false);
    expect(threads[0].awaitingReply).toBe(true);
    expect(threads[0].from.email).toBe("them@x.com"); // from = last sender
  });

  test("isFromMe / awaitingReply are exposed on every thread (for --json)", async () => {
    const portalResult = [
      jsonThread("me-last", [
        { id: "m1", from: { email: "them@x.com", name: "Them" },
          date: "2026-03-20T10:00:00Z", labelIds: ["INBOX"] },
        { id: "m2", from: { email: "owner-alias@other.org", name: "Owner" },
          date: "2026-03-20T11:00:00Z", labelIds: ["SENT"] },
      ]),
      jsonThread("them-last", [
        { id: "n1", from: { email: "them@x.com", name: "Them" },
          date: "2026-03-21T10:00:00Z", labelIds: ["INBOX"] },
      ]),
    ];
    const { provider } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { limit: 10 });
    // Returned `id` for json-shape threads is the latest message id, so key by
    // the latest sender instead.
    const byLatestId = Object.fromEntries(threads.map((t) => [t.id, t]));

    expect(byLatestId["m2"].isFromMe).toBe(true);  // owner alias sent last
    expect(byLatestId["m2"].awaitingReply).toBe(false);
    expect(byLatestId["n1"].isFromMe).toBe(false); // them sent last
    expect(byLatestId["n1"].awaitingReply).toBe(true);
  });

  test("needs-reply falls back to account-email match when SENT label is absent", async () => {
    // A cached message with no SENT label but sent from the active account
    // address should still be recognized as me-last via the email fallback.
    const portalResult = [
      jsonThread("no-label", [
        { id: "m1", from: { email: "them@x.com", name: "Them" },
          date: "2026-03-20T10:00:00Z", labelIds: ["INBOX"] },
        { id: "m2", from: { email: "user@example.com", name: "User" },
          date: "2026-03-20T11:00:00Z", labelIds: [] },
      ]),
    ];
    const { provider } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { needsReply: true, limit: 10 });

    expect(threads).toHaveLength(0);
  });
});

/** Build a fake searchTable query result (FTS format) */
function makeSearchTableResult(count: number) {
  return {
    threads: Array.from({ length: count }, (_, i) => ({
      json: JSON.stringify({
        id: `thread_${i}`,
        historyId: `hist_${i}`,
        messages: [
          {
            id: `thread_${i}`,
            threadId: `thread_${i}`,
            subject: `Invoice ${i}`,
            from: { email: `sender${i}@example.com`, raw: `sender${i}@example.com`, name: `Sender ${i}`, rawName: `Sender ${i}` },
            to: [{ email: "user@example.com", raw: "user@example.com" }],
            date: `2026-03-${String(20 + i).padStart(2, "0")}T12:00:00Z`,
            snippet: `Invoice preview ${i}`,
            labelIds: ["INBOX"],
          },
        ],
      }),
      listIds: ["INBOX"],
      snippet: `<b>Invoice</b> preview ${i}`,
      needsRender: false,
      superhumanData: null,
    })),
    noMoreOnDisk: true,
  };
}

describe("searchInbox with SuperhumanProvider", () => {
  // searchInbox() uses the local SQLite FTS index (searchTable service) via portal
  // when a CDP connection is available.

  test("searchInbox calls portalInvoke with searchTable service", async () => {
    const ftsResult = makeSearchTableResult(2);
    const { provider, portalMock } = createProviderWithPortal(ftsResult);

    const results = await searchInbox(provider, { query: "invoice", limit: 10 });

    // Portal MUST be called with searchTable service
    expect(portalMock).toHaveBeenCalled();
    const [service, method] = (portalMock.mock.calls[0] as any[]);
    expect(service).toBe("searchTable");
    expect(method).toBe("query");
  });

  test("searchInbox maps FTS results to InboxThread[]", async () => {
    const ftsResult = makeSearchTableResult(2);
    const { provider } = createProviderWithPortal(ftsResult);

    const results = await searchInbox(provider, { query: "invoice" });

    expect(results).toHaveLength(2);
    // Results are sorted by date descending — thread_1 (2026-03-21) before thread_0 (2026-03-20)
    expect(results[0].id).toBe("thread_1");
    expect(results[1].id).toBe("thread_0");
    expect(results[1].subject).toBe("Invoice 0");
    expect(results[1].from.email).toBe("sender0@example.com");
  });

  test("searchInbox returns empty array when no portal available", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    // No CDP connection: hasPortal() returns false
    const results = await searchInbox(provider, { query: "invoice" });
    expect(results).toEqual([]);
  });

  test("listInbox still uses portalInvoke with empty query for inbox listing", async () => {
    const { provider, portalMock } = createProviderWithPortal(makePortalListResult(3));

    await listInbox(provider, { limit: 10 });

    const passedQuery = (portalMock.mock.calls[0] as any[])[2][1].query;
    expect(passedQuery).toBe("");
  });
});

describe("inbox without portal (no CDP connection)", () => {
  test("throws helpful error when no portal is available for inbox listing", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    // No CDP connection = hasPortal() returns false

    expect(listInbox(provider)).rejects.toThrow(
      "Inbox listing requires running Superhuman app (portal RPC)"
    );
  });

  test("error message mentions 'superhuman account auth'", async () => {
    const provider = new SuperhumanProvider(sampleToken);

    expect(listInbox(provider)).rejects.toThrow("superhuman account auth");
  });
});

// ---------------------------------------------------------------------------
// SQLite-first path tests
// ---------------------------------------------------------------------------

import * as sqliteSearch from "../sqlite-search";
// Snapshot REAL exports before any mock.module runs — restoring to the live
// `sqliteSearch` namespace is self-defeating (mock.module mutates its bindings),
// so a stable snapshot is what prevents cross-file mock leakage.
const REAL_SQLITE = { ...sqliteSearch };

/** Build a fake ListInboxRow[] with parsed JSON thread data */
function makeSQLiteRows(count: number, opts?: { allUnread?: boolean }): sqliteSearch.ListInboxRow[] {
  return Array.from({ length: count }, (_, i) => ({
    threadId: `thread_${i}`,
    json: JSON.stringify({
      id: `thread_${i}`,
      messages: [
        {
          id: `msg_${i}_a`,
          subject: `SQLite Subject ${i}`,
          from: { email: `sqlite${i}@example.com`, name: `SQLite Sender ${i}` },
          date: `2026-04-${String(1 + i).padStart(2, "0")}T10:00:00Z`,
          snippet: `SQLite snippet ${i}`,
          labelIds: ["INBOX", ...(opts?.allUnread || i === 0 ? ["UNREAD"] : [])],
        },
      ],
    }),
    labelIds: ["INBOX", ...(opts?.allUnread || i === 0 ? ["UNREAD"] : [])],
  }));
}

describe("listInbox SQLite-first path", () => {
  test("uses SQLite when DB available, does not call portalInvoke", async () => {
    const rows = makeSQLiteRows(3);
    const dbMock = mock(() => rows);
    mock.module("../sqlite-search", () => ({
      listInboxFromDB: dbMock,
    }));

    const portalResult = makePortalListResult(5);
    const { provider, portalMock } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { limit: 10 });

    expect(dbMock).toHaveBeenCalledTimes(1);
    expect(portalMock).not.toHaveBeenCalled();
    expect(threads).toHaveLength(3);
    expect(threads[0].subject).toBe("SQLite Subject 0");
    expect(threads[0].from.email).toBe("sqlite0@example.com");

    mock.module("../sqlite-search", () => REAL_SQLITE);
  });

  test("falls back to portal when SQLite returns null", async () => {
    const dbMock = mock(() => null);
    mock.module("../sqlite-search", () => ({
      listInboxFromDB: dbMock,
    }));

    const portalResult = makePortalListResult(2);
    const { provider, portalMock } = createProviderWithPortal(portalResult);

    const threads = await listInbox(provider, { limit: 10 });

    expect(dbMock).toHaveBeenCalledTimes(1);
    expect(portalMock).toHaveBeenCalledTimes(1);
    expect(threads).toHaveLength(2);

    mock.module("../sqlite-search", () => REAL_SQLITE);
  });

  test("SQLite path respects unreadOnly filter", async () => {
    // 3 rows: only index 0 has UNREAD
    const rows = makeSQLiteRows(3);
    const dbMock = mock(() => rows);
    mock.module("../sqlite-search", () => ({
      listInboxFromDB: dbMock,
    }));

    const { provider, portalMock } = createProviderWithPortal([]);

    const threads = await listInbox(provider, { unreadOnly: true, limit: 10 });

    expect(portalMock).not.toHaveBeenCalled();
    expect(threads).toHaveLength(1);
    expect(threads[0].labelIds).toContain("UNREAD");

    mock.module("../sqlite-search", () => REAL_SQLITE);
  });

  test("SQLite path respects splitInbox option (passes correct listId)", async () => {
    const rows = makeSQLiteRows(2);
    const dbMock = mock((_email: string, listId: string, _limit: number) => rows);
    mock.module("../sqlite-search", () => ({
      listInboxFromDB: dbMock,
    }));

    const { provider, portalMock } = createProviderWithPortal([]);

    await listInbox(provider, { splitInbox: "important", limit: 5 });

    expect(portalMock).not.toHaveBeenCalled();
    expect(dbMock).toHaveBeenCalledTimes(1);
    const [emailArg, listIdArg] = dbMock.mock.calls[0] as [string, string, number];
    expect(listIdArg).toBe("SH_IMPORTANT");

    mock.module("../sqlite-search", () => REAL_SQLITE);
  });
});
