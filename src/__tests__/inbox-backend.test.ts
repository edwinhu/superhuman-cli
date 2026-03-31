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
