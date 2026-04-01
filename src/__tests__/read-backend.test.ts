/**
 * Tests for read.ts using SuperhumanProvider (portal + backend API paths).
 *
 * Mocks portalInvoke and globalThis.fetch to test routing.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { SuperhumanProvider } from "../superhuman-provider";
import type { SuperhumanTokenInfo } from "../superhuman-provider";
import { readThread, type ThreadMessage } from "../read";

const sampleToken: SuperhumanTokenInfo = {
  token: "test-jwt-token",
  email: "user@example.com",
  accountId: "acct_123",
  expires: Date.now() + 3600_000,
};

/** Fake portal getAsync response — thread with messages map */
function makePortalThreadResponse(threadId: string) {
  return {
    id: threadId,
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
  };
}

/** Fake backend getThreads response for a single thread */
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

  test("with portal: calls portalInvoke('threadInternal', 'getAsync', [threadId])", async () => {
    const threadId = "thread_abc123";
    const portalResponse = makePortalThreadResponse(threadId);

    // Create provider with a mock connection
    const provider = new SuperhumanProvider(sampleToken);

    // Mock portalInvoke directly
    const mockPortalInvoke = mock(() => Promise.resolve(portalResponse));
    (provider as any).conn = {}; // make hasPortal() return true
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, threadId);

    // Verify portalInvoke was called correctly
    expect(mockPortalInvoke).toHaveBeenCalledTimes(1);
    expect(mockPortalInvoke.mock.calls[0]).toEqual([
      "threadInternal",
      "getAsync",
      [threadId, { format: "full" }],
    ]);

    // Verify parsed output
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe("msg_1");
    expect(messages[0].threadId).toBe(threadId);
    expect(messages[0].subject).toBe("Hello World");
    expect(messages[0].from.email).toBe("alice@example.com");
    expect(messages[0].from.name).toBe("Alice Smith");
  });

  test("without portal: calls backendFetch('/v3/userdata.getThreads')", async () => {
    const threadId = "thread_abc123";
    const backendResponse = makeBackendGetThreadsResponse(threadId);
    const mf = setupMockFetch(backendResponse);

    // Provider without connection (no portal)
    const provider = new SuperhumanProvider(sampleToken);
    expect(provider.hasPortal()).toBe(false);

    const messages = await readThread(provider, threadId);

    // Verify backendFetch was called
    expect(mf).toHaveBeenCalledTimes(1);
    const [url, opts] = mf.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://mail.superhuman.com/~backend/v3/userdata.getThreads"
    );
    const body = JSON.parse(opts.body as string);
    expect(body.filter).toBeDefined();
    expect(body.limit).toBeDefined();

    // Verify parsed output
    expect(messages).toHaveLength(2);
    expect(messages[0].subject).toBe("Hello World");
  });

  test("response parsing: parses portal thread into ThreadMessage[]", async () => {
    const threadId = "thread_parse_test";
    const portalResponse = makePortalThreadResponse(threadId);

    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() => Promise.resolve(portalResponse));
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, threadId);

    // Check all fields of first message
    const m1 = messages[0];
    expect(m1.id).toBe("msg_1");
    expect(m1.threadId).toBe(threadId);
    expect(m1.subject).toBe("Hello World");
    expect(m1.from).toEqual({ email: "alice@example.com", name: "Alice Smith" });
    expect(m1.to).toEqual([{ email: "user@example.com", name: "user@example.com" }]);
    expect(m1.cc).toEqual([{ email: "cc@example.com", name: "cc@example.com" }]);
    expect(m1.date).toBe("2026-03-30T10:00:00Z");
    expect(m1.snippet).toBe("Hi there, this is a test");
    expect(m1.body).toBe("<p>Hi there, this is a test email.</p>");

    // Check second message
    const m2 = messages[1];
    expect(m2.id).toBe("msg_2");
    expect(m2.from.email).toBe("user@example.com");
  });

  test("response parsing: parses backend thread into ThreadMessage[]", async () => {
    const threadId = "thread_backend_parse";
    const backendResponse = makeBackendGetThreadsResponse(threadId);
    setupMockFetch(backendResponse);

    const provider = new SuperhumanProvider(sampleToken);
    const messages = await readThread(provider, threadId);

    expect(messages).toHaveLength(2);

    const m1 = messages[0];
    expect(m1.id).toBe("msg_1");
    expect(m1.subject).toBe("Hello World");
    expect(m1.from.email).toBe("alice@example.com");
    expect(m1.from.name).toBe("Alice Smith");
    expect(m1.body).toBe("<p>Hi there, this is a test email.</p>");

    const m2 = messages[1];
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

  test("handles empty thread (no messages)", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() =>
      Promise.resolve({ id: "thread_empty", messages: {} })
    );
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
        id: "t1",
        messages: {
          m1: {
            id: "m1",
            threadId: "t1",
            subject: "Test",
            from: "plain@example.com",
            to: [],
            cc: [],
            date: "2026-03-31T12:00:00Z",
            snippet: "Hello",
          },
        },
      })
    );
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, "t1");
    expect(messages[0].from.email).toBe("plain@example.com");
    expect(messages[0].from.name).toBe("plain@example.com");
  });

  test("from field parses 'Name <email>' format", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() =>
      Promise.resolve({
        id: "t1",
        messages: {
          m1: {
            id: "m1",
            threadId: "t1",
            subject: "Test",
            from: "Bob Jones <bob@example.com>",
            to: [],
            cc: [],
            date: "2026-03-31T12:00:00Z",
            snippet: "Hello",
          },
        },
      })
    );
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, "t1");
    expect(messages[0].from.email).toBe("bob@example.com");
    expect(messages[0].from.name).toBe("Bob Jones");
  });

  test("messages are sorted by date ascending", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    const mockPortalInvoke = mock(() =>
      Promise.resolve({
        id: "t1",
        messages: {
          newer: {
            id: "newer",
            threadId: "t1",
            subject: "Test",
            from: "a@example.com",
            to: [],
            cc: [],
            date: "2026-03-31T14:00:00Z",
            snippet: "Later",
          },
          older: {
            id: "older",
            threadId: "t1",
            subject: "Test",
            from: "b@example.com",
            to: [],
            cc: [],
            date: "2026-03-31T10:00:00Z",
            snippet: "Earlier",
          },
        },
      })
    );
    (provider as any).conn = {};
    provider.portalInvoke = mockPortalInvoke as any;

    const messages = await readThread(provider, "t1");
    expect(messages[0].id).toBe("older");
    expect(messages[1].id).toBe("newer");
  });
});
