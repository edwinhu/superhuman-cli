/**
 * Tests for read.ts using SuperhumanProvider (portal + backend API paths).
 *
 * Mocks portalInvoke and globalThis.fetch to test routing.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { SuperhumanProvider } from "../superhuman-provider";
import type { SuperhumanTokenInfo } from "../superhuman-provider";
import { readThread, type ThreadMessage } from "../read";
import * as sqliteSearch from "../sqlite-search";

const sampleToken: SuperhumanTokenInfo = {
  token: "test-jwt-token",
  email: "user@example.com",
  accountId: "acct_123",
  expires: Date.now() + 3600_000,
};

/**
 * Build a portal listAsync response wrapping a single thread.
 * The thread item has shape: { json: { id, messages: [] }, listIds }
 * Messages are an array of message objects.
 */
function makePortalListAsyncResponse(threadInternalId: string, latestMsgId: string) {
  return {
    threads: [
      {
        json: {
          id: threadInternalId,
          messages: [
            {
              id: "msg_1",
              threadId: threadInternalId,
              subject: "Hello World",
              from: "Alice Smith <alice@example.com>",
              to: ["user@example.com"],
              cc: ["cc@example.com"],
              date: "2026-03-30T10:00:00Z",
              snippet: "Hi there, this is a test",
              body: "<p>Hi there, this is a test email.</p>",
              labelIds: ["INBOX", "UNREAD"],
            },
            {
              id: latestMsgId,
              threadId: threadInternalId,
              subject: "Re: Hello World",
              from: "user@example.com",
              to: ["alice@example.com"],
              cc: [],
              date: "2026-03-30T12:00:00Z",
              snippet: "Thanks for the email",
              body: "<p>Thanks for the email.</p>",
              labelIds: ["SENT"],
            },
          ],
        },
        listIds: ["INBOX"],
      },
    ],
  };
}

/** Fake backend getThreads response for a single thread (no listId filter) */
function makeBackendGetThreadsResponse(threadId: string) {
  return {
    threadList: [
      {
        thread: {
          historyId: "hist_1",
          messages: {
            msg_1: {
              id: "msg_1",
              threadId,
              subject: "Hello World",
              from: "Alice Smith <alice@example.com>",
              to: ["user@example.com"],
              cc: ["cc@example.com"],
              date: "2026-03-30T10:00:00Z",
              snippet: "Hi there, this is a test",
              body: "<p>Hi there, this is a test email.</p>",
              labelIds: ["INBOX", "UNREAD"],
            },
            msg_2: {
              id: "msg_2",
              threadId,
              subject: "Re: Hello World",
              from: "user@example.com",
              to: ["alice@example.com"],
              cc: [],
              date: "2026-03-30T12:00:00Z",
              snippet: "Thanks for the email",
              body: "<p>Thanks for the email.</p>",
              labelIds: ["SENT"],
            },
          },
          reminder: null,
        },
      },
    ],
  };
}

describe("readThread with SuperhumanProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Ensure sqlite-search is always restored to real module before each test
    mock.module("../sqlite-search", () => sqliteSearch);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function setupMockFetch(responseBody: any) {
    const mockFn = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    globalThis.fetch = mockFn as any;
    return mockFn;
  }

  // ---------------------------------------------------------------------------
  // Regression test: the original 400 error
  // ---------------------------------------------------------------------------

  test("REGRESSION: portal path uses listAsync not getAsync (getAsync caused 400 on Exchange)", async () => {
    // The bug: readThreadPortal called portalInvoke("threadInternal", "getAsync", ...)
    // which does not exist on the portal and caused 400 errors for Exchange accounts.
    // Fix: use listAsync and match by message ID.
    const threadInternalId = "thread_internal_abc";
    const latestMsgId = "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AXIqdBgk1EkKJ_kY4ZzlqaQABueROowAA";
    const portalResponse = makePortalListAsyncResponse(threadInternalId, latestMsgId);

    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() => Promise.resolve(portalResponse));
    (provider as any).conn = {}; // make hasPortal() return true
    provider.portalInvoke = mockPortalInvoke as any;

    // User passes the latest message ID (as returned by inbox)
    const messages = await readThread(provider, latestMsgId);

    // Must call listAsync, NOT getAsync
    expect(mockPortalInvoke).toHaveBeenCalledTimes(1);
    const [service, method] = mockPortalInvoke.mock.calls[0] as unknown as [string, string, any[]];
    expect(service).toBe("threadInternal");
    expect(method).toBe("listAsync");
    expect(method).not.toBe("getAsync");

    // Should return both messages
    expect(messages).toHaveLength(2);
    expect(messages[1]!.id).toBe(latestMsgId);
  });

  test("REGRESSION: backend path does not send listId filter (listId caused 400 on Exchange)", async () => {
    // The bug: readThreadBackend sent filter: { listId: "INBOX" } which the
    // Superhuman backend does not support — returning 400 for Exchange accounts.
    // Fix: use filter: {} (no listId).
    const threadId = "thread_abc123";
    const backendResponse = makeBackendGetThreadsResponse(threadId);
    const mf = setupMockFetch(backendResponse);

    const provider = new SuperhumanProvider(sampleToken);
    expect(provider.hasPortal()).toBe(false);

    await readThread(provider, threadId);

    expect(mf).toHaveBeenCalledTimes(1);
    const [, opts] = mf.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    // Must NOT contain listId
    expect(body.filter).toBeDefined();
    expect((body.filter as any).listId).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Portal path: uses listAsync + matches by message ID
  // ---------------------------------------------------------------------------

  test("portal: calls listAsync('INBOX', ...) and matches thread by message ID", async () => {
    const threadInternalId = "thread_abc123";
    const latestMsgId = "msg_2";
    const portalResponse = makePortalListAsyncResponse(threadInternalId, latestMsgId);

    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() => Promise.resolve(portalResponse));
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    // Pass the latest message ID (what inbox returns as the thread ID)
    const messages = await readThread(provider, latestMsgId);

    expect(mockPortalInvoke).toHaveBeenCalledTimes(1);
    const [service, method, args] = mockPortalInvoke.mock.calls[0] as unknown as [string, string, any[]];
    expect(service).toBe("threadInternal");
    expect(method).toBe("listAsync");
    expect(args[0]).toBe("INBOX");

    expect(messages).toHaveLength(2);
    // Messages sorted oldest-first
    expect(messages[0]!.id).toBe("msg_1");
    expect(messages[1]!.id).toBe(latestMsgId);
    expect(messages[0]!.subject).toBe("Hello World");
    expect(messages[0]!.from.email).toBe("alice@example.com");
    expect(messages[0]!.from.name).toBe("Alice Smith");
  });

  test("portal: also matches by thread internal ID (json.id)", async () => {
    const threadInternalId = "thread_by_thread_id";
    const portalResponse = makePortalListAsyncResponse(threadInternalId, "msg_latest");

    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() => Promise.resolve(portalResponse));
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    // Pass the thread's internal ID instead of message ID
    const messages = await readThread(provider, threadInternalId);
    expect(messages).toHaveLength(2);
  });

  test("portal: returns empty array if no thread matches the ID", async () => {
    const portalResponse = makePortalListAsyncResponse("thread_other", "msg_other");

    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() => Promise.resolve(portalResponse));
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, "nonexistent_id");
    expect(messages).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Backend path: no listId filter
  // ---------------------------------------------------------------------------

  test("without portal: calls backendFetch('/v3/userdata.getThreads') without listId", async () => {
    const threadId = "thread_abc123";
    const backendResponse = makeBackendGetThreadsResponse(threadId);
    const mf = setupMockFetch(backendResponse);

    const provider = new SuperhumanProvider(sampleToken);
    expect(provider.hasPortal()).toBe(false);

    const messages = await readThread(provider, threadId);

    expect(mf).toHaveBeenCalledTimes(1);
    const [url, opts] = mf.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://mail.superhuman.com/~backend/v3/userdata.getThreads"
    );
    const body = JSON.parse(opts.body as string);
    expect(body.filter).toBeDefined();
    expect((body.filter as any).listId).toBeUndefined();
    expect(body.limit).toBeDefined();

    expect(messages).toHaveLength(2);
    expect(messages[0]!.subject).toBe("Hello World");
  });

  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

  test("response parsing: portal listAsync result parsed into ThreadMessage[]", async () => {
    const threadInternalId = "thread_parse_test";
    const latestMsgId = "msg_2";
    const portalResponse = makePortalListAsyncResponse(threadInternalId, latestMsgId);

    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() => Promise.resolve(portalResponse));
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, latestMsgId);

    const m1 = messages[0]!;
    expect(m1.id).toBe("msg_1");
    expect(m1.threadId).toBe(threadInternalId);
    expect(m1.subject).toBe("Hello World");
    expect(m1.from).toEqual({ email: "alice@example.com", name: "Alice Smith" });
    expect(m1.to).toEqual([{ email: "user@example.com", name: "user@example.com" }]);
    expect(m1.cc).toEqual([{ email: "cc@example.com", name: "cc@example.com" }]);
    expect(m1.date).toBe("2026-03-30T10:00:00Z");
    expect(m1.snippet).toBe("Hi there, this is a test");
    expect(m1.body).toBe("<p>Hi there, this is a test email.</p>");

    const m2 = messages[1]!;
    expect(m2.id).toBe(latestMsgId);
    expect(m2.from.email).toBe("user@example.com");
  });

  test("response parsing: backend getThreads result parsed into ThreadMessage[]", async () => {
    const threadId = "thread_backend_parse";
    const backendResponse = makeBackendGetThreadsResponse(threadId);
    setupMockFetch(backendResponse);

    const provider = new SuperhumanProvider(sampleToken);
    const messages = await readThread(provider, threadId);

    expect(messages).toHaveLength(2);

    const m1 = messages[0]!;
    expect(m1.id).toBe("msg_1");
    expect(m1.subject).toBe("Hello World");
    expect(m1.from.email).toBe("alice@example.com");
    expect(m1.from.name).toBe("Alice Smith");
    expect(m1.body).toBe("<p>Hi there, this is a test email.</p>");

    const m2 = messages[1]!;
    expect(m2.id).toBe("msg_2");
    expect(m2.from.email).toBe("user@example.com");
  });

  test("portal fallback: falls back to backendFetch if portalInvoke throws", async () => {
    const threadId = "thread_fallback";
    const backendResponse = makeBackendGetThreadsResponse(threadId);
    const mf = setupMockFetch(backendResponse);

    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() =>
      Promise.reject(new Error("portal unavailable"))
    );
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, threadId);

    // Should have fallen back to backendFetch
    expect(mf).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(2);
  });

  test("handles empty inbox (no threads in listAsync response)", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() => Promise.resolve({ threads: [] }));
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, "thread_empty");
    expect(messages).toEqual([]);
  });

  test("handles null/401 backend response", async () => {
    const mockFn = mock(() =>
      Promise.resolve(new Response("", { status: 401 }))
    );
    globalThis.fetch = mockFn as any;

    const provider = new SuperhumanProvider(sampleToken);
    const messages = await readThread(provider, "thread_notfound");
    expect(messages).toEqual([]);
  });

  test("from field parses email-only format", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() =>
      Promise.resolve({
        threads: [
          {
            json: {
              id: "t1",
              messages: [
                {
                  id: "m1",
                  threadId: "t1",
                  subject: "Test",
                  from: "plain@example.com",
                  to: [],
                  cc: [],
                  date: "2026-03-31T12:00:00Z",
                  snippet: "Hello",
                },
              ],
            },
            listIds: ["INBOX"],
          },
        ],
      })
    );
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, "m1");
    expect(messages[0]!.from.email).toBe("plain@example.com");
    expect(messages[0]!.from.name).toBe("plain@example.com");
  });

  test("from field parses 'Name <email>' format", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() =>
      Promise.resolve({
        threads: [
          {
            json: {
              id: "t1",
              messages: [
                {
                  id: "m1",
                  threadId: "t1",
                  subject: "Test",
                  from: "Bob Jones <bob@example.com>",
                  to: [],
                  cc: [],
                  date: "2026-03-31T12:00:00Z",
                  snippet: "Hello",
                },
              ],
            },
            listIds: ["INBOX"],
          },
        ],
      })
    );
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, "m1");
    expect(messages[0]!.from.email).toBe("bob@example.com");
    expect(messages[0]!.from.name).toBe("Bob Jones");
  });

  test("messages are sorted by date ascending (oldest first)", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() =>
      Promise.resolve({
        threads: [
          {
            json: {
              id: "t1",
              messages: [
                {
                  id: "newer",
                  threadId: "t1",
                  subject: "Test",
                  from: "a@example.com",
                  to: [],
                  cc: [],
                  date: "2026-03-31T14:00:00Z",
                  snippet: "Later",
                },
                {
                  id: "older",
                  threadId: "t1",
                  subject: "Test",
                  from: "b@example.com",
                  to: [],
                  cc: [],
                  date: "2026-03-31T10:00:00Z",
                  snippet: "Earlier",
                },
              ],
            },
            listIds: ["INBOX"],
          },
        ],
      })
    );
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, "newer");
    expect(messages[0]!.id).toBe("older");
    expect(messages[1]!.id).toBe("newer");
  });

  // ---------------------------------------------------------------------------
  // SQLite path tests (MUST be last — mock.module affects global state)
  // ---------------------------------------------------------------------------

  describe("SQLite-first path", () => {
    function makeSQLiteThread(threadId: string) {
      return {
        id: threadId,
        messages: [
          {
            id: "msg_sqlite_1",
            threadId,
            subject: "SQLite Thread",
            from: { email: "alice@example.com", name: "Alice" },
            to: [{ email: "user@example.com", name: "User" }],
            cc: [],
            date: "2026-04-01T10:00:00Z",
            snippet: "From SQLite",
            body: "<p>SQLite body</p>",
          },
          {
            id: "msg_sqlite_2",
            threadId,
            subject: "Re: SQLite Thread",
            from: { email: "user@example.com", name: "User" },
            to: [{ email: "alice@example.com", name: "Alice" }],
            cc: [],
            date: "2026-04-01T12:00:00Z",
            snippet: "Reply from SQLite",
            body: "<p>Reply body</p>",
          },
        ],
      };
    }

    function mockSQLite(readThreadFromDB: (...args: any[]) => any) {
      mock.module("../sqlite-search", () => ({
        ...sqliteSearch,
        readThreadFromDB,
      }));
    }

    afterEach(() => {
      mock.module("../sqlite-search", () => sqliteSearch);
    });

    test("readThread uses SQLite when DB has thread", async () => {
      const threadId = "thread_sqlite_hit";
      mockSQLite(() => makeSQLiteThread(threadId));
      const { readThread: readThreadFresh } = await import("../read");

      const provider = new SuperhumanProvider(sampleToken);
      const mockPortalInvoke = mock(() => Promise.resolve({ threads: [] }));
      (provider as any).conn = {};
      provider.portalInvoke = mockPortalInvoke as any;

      const messages = await readThreadFresh(provider, threadId);

      // Should have messages from SQLite
      expect(messages).toHaveLength(2);
      expect(messages[0]!.id).toBe("msg_sqlite_1");
      expect(messages[1]!.id).toBe("msg_sqlite_2");
      // Portal should NOT have been called
      expect(mockPortalInvoke).not.toHaveBeenCalled();

    });

    test("readThread falls back to portal when SQLite returns null", async () => {
      mockSQLite(() => null);
      const { readThread: readThreadFresh } = await import("../read");

      const threadId = "thread_portal_fallback";
      const portalResponse = makePortalListAsyncResponse(threadId, "msg_2");

      const provider = new SuperhumanProvider(sampleToken);
      const mockPortalInvoke = mock(() => Promise.resolve(portalResponse));
      (provider as any).conn = {};
      provider.portalInvoke = mockPortalInvoke as any;

      const messages = await readThreadFresh(provider, threadId);

      // SQLite returned null, so portal should have been called
      expect(mockPortalInvoke).toHaveBeenCalledTimes(1);
      expect(messages).toHaveLength(2);

    });

    test("readThread falls back to portal when SQLite throws", async () => {
      mockSQLite(() => {
        throw new Error("SQLite DB corrupted");
      });
      const { readThread: readThreadFresh } = await import("../read");

      const threadId = "thread_sqlite_error";
      const portalResponse = makePortalListAsyncResponse(threadId, "msg_2");

      const provider = new SuperhumanProvider(sampleToken);
      const mockPortalInvoke = mock(() => Promise.resolve(portalResponse));
      (provider as any).conn = {};
      provider.portalInvoke = mockPortalInvoke as any;

      const messages = await readThreadFresh(provider, threadId);

      // SQLite threw, so portal should have been called
      expect(mockPortalInvoke).toHaveBeenCalledTimes(1);
      expect(messages).toHaveLength(2);

    });

    test("SQLite path handles object from field correctly", async () => {
      const threadId = "thread_object_from";
      mockSQLite(() => makeSQLiteThread(threadId));
      const { readThread: readThreadFresh } = await import("../read");

      const provider = new SuperhumanProvider(sampleToken);
      const mockPortalInvoke = mock(() => Promise.resolve({ threads: [] }));
      (provider as any).conn = {};
      provider.portalInvoke = mockPortalInvoke as any;

      const messages = await readThreadFresh(provider, threadId);

      // from should be properly parsed from object format
      expect(messages[0]!.from).toEqual({ email: "alice@example.com", name: "Alice" });
      expect(messages[1]!.from).toEqual({ email: "user@example.com", name: "User" });

    });
  });
});
