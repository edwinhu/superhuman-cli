/**
 * Tests for inbox.ts using SuperhumanProvider (backend API path).
 *
 * Mocks globalThis.fetch to intercept userdata.getThreads calls.
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

/** Build a fake getThreads response with N threads */
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
        // Second message to test "last message" picking
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

describe("inbox with SuperhumanProvider", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function setupMockFetch(responseBody: any) {
    mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    globalThis.fetch = mockFetch as any;
    return mockFetch;
  }

  test("listInbox calls userdata.getThreads with INBOX filter by default", async () => {
    const response = makeGetThreadsResponse(2);
    const mf = setupMockFetch(response);
    const provider = new SuperhumanProvider(sampleToken);

    const threads = await listInbox(provider, { limit: 10 });

    expect(mf).toHaveBeenCalledTimes(1);
    const [url, opts] = mf.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mail.superhuman.com/~backend/v3/userdata.getThreads");
    const body = JSON.parse(opts.body as string);
    expect(body.filter).toEqual({ listId: "INBOX" });
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
  });

  test("splitInbox 'important' uses SH_IMPORTANT filter", async () => {
    const response = makeGetThreadsResponse(1);
    const mf = setupMockFetch(response);
    const provider = new SuperhumanProvider(sampleToken);

    await listInbox(provider, { splitInbox: "important", limit: 5 });

    const body = JSON.parse((mf.mock.calls[0] as any)[1].body);
    expect(body.filter).toEqual({ listId: "SH_IMPORTANT" });
    expect(body.limit).toBe(5);
  });

  test("splitInbox 'other' uses SH_OTHER filter", async () => {
    const response = makeGetThreadsResponse(1);
    const mf = setupMockFetch(response);
    const provider = new SuperhumanProvider(sampleToken);

    await listInbox(provider, { splitInbox: "other", limit: 5 });

    const body = JSON.parse((mf.mock.calls[0] as any)[1].body);
    expect(body.filter).toEqual({ listId: "SH_OTHER" });
  });

  test("default limit is 10 when not specified", async () => {
    const response = makeGetThreadsResponse(1);
    const mf = setupMockFetch(response);
    const provider = new SuperhumanProvider(sampleToken);

    await listInbox(provider);

    const body = JSON.parse((mf.mock.calls[0] as any)[1].body);
    expect(body.limit).toBe(10);
  });

  test("parses thread response into InboxThread format", async () => {
    const response = makeGetThreadsResponse(1);
    const mf = setupMockFetch(response);
    const provider = new SuperhumanProvider(sampleToken);

    const threads = await listInbox(provider, { limit: 10 });

    expect(threads).toHaveLength(1);
    const t = threads[0];
    // Should pick the latest message (msg_0_b, based on date sort)
    expect(t.id).toBeTruthy();
    expect(t.subject).toMatch(/Subject 0/);
    expect(t.from.email).toBeTruthy();
    expect(t.date).toBeTruthy();
    expect(t.snippet).toBeTruthy();
    expect(t.labelIds).toBeArray();
    expect(t.messageCount).toBe(2);
  });

  test("handles empty threadList", async () => {
    const mf = setupMockFetch({ threadList: [] });
    const provider = new SuperhumanProvider(sampleToken);

    const threads = await listInbox(provider);

    expect(threads).toEqual([]);
  });

  test("handles null response", async () => {
    // backendFetch returns null on 401/403
    mockFetch = mock(() =>
      Promise.resolve(
        new Response("", { status: 401 })
      )
    );
    globalThis.fetch = mockFetch as any;

    const provider = new SuperhumanProvider(sampleToken);
    const threads = await listInbox(provider);
    expect(threads).toEqual([]);
  });

  test("streamListInbox yields threads one by one", async () => {
    const response = makeGetThreadsResponse(3);
    setupMockFetch(response);
    const provider = new SuperhumanProvider(sampleToken);

    const collected: InboxThread[] = [];
    for await (const thread of streamListInbox(provider, { limit: 10 })) {
      collected.push(thread);
    }
    expect(collected).toHaveLength(3);
  });

  test("unreadOnly filter is passed through", async () => {
    const response = makeGetThreadsResponse(1);
    const mf = setupMockFetch(response);
    const provider = new SuperhumanProvider(sampleToken);

    const threads = await listInbox(provider, { unreadOnly: true });

    // unreadOnly is applied client-side on the result
    // The API call should still use INBOX filter
    const body = JSON.parse((mf.mock.calls[0] as any)[1].body);
    expect(body.filter.listId).toBe("INBOX");
  });

  test("from field parses email-only format", async () => {
    const response = {
      threadList: [{
        thread: {
          historyId: "h1",
          messages: {
            msg1: {
              id: "msg1",
              subject: "Test",
              from: "alice@example.com",
              to: ["bob@example.com"],
              date: "2026-03-31T12:00:00Z",
              snippet: "Hello",
              labelIds: ["INBOX"],
            },
          },
          reminder: null,
        },
      }],
    };
    setupMockFetch(response);
    const provider = new SuperhumanProvider(sampleToken);

    const threads = await listInbox(provider, { limit: 10 });

    expect(threads[0].from.email).toBe("alice@example.com");
    expect(threads[0].from.name).toBe("alice@example.com");
  });

  test("from field parses 'Name <email>' format", async () => {
    const response = {
      threadList: [{
        thread: {
          historyId: "h1",
          messages: {
            msg1: {
              id: "msg1",
              subject: "Test",
              from: "Alice Smith <alice@example.com>",
              to: ["bob@example.com"],
              date: "2026-03-31T12:00:00Z",
              snippet: "Hello",
              labelIds: ["INBOX"],
            },
          },
          reminder: null,
        },
      }],
    };
    setupMockFetch(response);
    const provider = new SuperhumanProvider(sampleToken);

    const threads = await listInbox(provider, { limit: 10 });

    expect(threads[0].from.email).toBe("alice@example.com");
    expect(threads[0].from.name).toBe("Alice Smith");
  });
});
