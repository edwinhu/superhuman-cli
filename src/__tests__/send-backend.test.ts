/**
 * Tests for send-api.ts and reply.ts using SuperhumanProvider (backend API path).
 *
 * Mocks globalThis.fetch to intercept Superhuman backend calls.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { SuperhumanProvider } from "../superhuman-provider";
import type { SuperhumanTokenInfo } from "../superhuman-provider";
import {
  sendEmailViaProvider,
  createDraftViaProvider,
  sendDraftByIdViaProvider,
} from "../send-api";
import { replyToThread, replyAllToThread, forwardThread } from "../reply";

const sampleToken: SuperhumanTokenInfo = {
  token: "test-jwt-token",
  email: "user@example.com",
  accountId: "acct_123",
  expires: Date.now() + 3600_000,
};

describe("send-api with SuperhumanProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Mock fetch that succeeds for all Superhuman backend calls.
   * Tracks call URLs for assertions.
   */
  function setupMockFetch() {
    const calls: string[] = [];
    const mockFn = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      calls.push(urlStr);

      // writeMessage (create draft)
      if (urlStr.includes("userdata.writeMessage")) {
        return Promise.resolve(
          new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })
        );
      }
      // messages/send
      if (urlStr.includes("messages/send")) {
        return Promise.resolve(
          new Response(JSON.stringify({ send_at: Date.now() }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      // getThreads (used by forward)
      if (urlStr.includes("userdata.getThreads")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              threadList: [
                {
                  thread: {
                    messages: {
                      msg1: {
                        id: "msg1",
                        subject: "Original Subject",
                        from: "sender@example.com",
                        to: ["user@example.com"],
                        date: "2026-03-20T12:00:00Z",
                        snippet: "Original message content",
                      },
                    },
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      // deleteDraft (userdata.deleteMessages)
      if (urlStr.includes("userdata.deleteMessages") || urlStr.includes("deleteMessage")) {
        return Promise.resolve(
          new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })
        );
      }
      // Default success
      return Promise.resolve(
        new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })
      );
    });
    globalThis.fetch = mockFn as any;
    return { mockFn, calls };
  }

  // ---- sendEmailViaProvider ----

  test("sendEmailViaProvider with SuperhumanProvider creates draft and sends", async () => {
    const { calls } = setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await sendEmailViaProvider(provider, {
      to: ["recipient@example.com"],
      subject: "Test Subject",
      body: "Hello, world!",
    });

    expect(result.success).toBe(true);
    expect(result.threadId).toBeDefined();
    expect(result.messageId).toBeDefined();
    // Should have called writeMessage (create draft) then messages/send
    const writeCall = calls.find((c) => c.includes("userdata.writeMessage"));
    const sendCall = calls.find((c) => c.includes("messages/send"));
    expect(writeCall).toBeDefined();
    expect(sendCall).toBeDefined();
  });

  test("sendEmailViaProvider with HTML body passes through without conversion", async () => {
    setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await sendEmailViaProvider(provider, {
      to: ["recipient@example.com"],
      subject: "HTML Test",
      body: "<p>Already HTML</p>",
      isHtml: true,
    });

    expect(result.success).toBe(true);
  });

  // ---- createDraftViaProvider ----

  test("createDraftViaProvider with SuperhumanProvider creates draft without sending", async () => {
    const { calls } = setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await createDraftViaProvider(provider, {
      to: ["recipient@example.com"],
      subject: "Draft Subject",
      body: "Draft body",
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(result.threadId).toBeDefined();
    // Should only call writeMessage, NOT messages/send
    const writeCall = calls.find((c) => c.includes("userdata.writeMessage"));
    const sendCall = calls.find((c) => c.includes("messages/send"));
    expect(writeCall).toBeDefined();
    expect(sendCall).toBeUndefined();
  });

  // ---- sendDraftByIdViaProvider ----

  test("sendDraftByIdViaProvider with SuperhumanProvider sends existing draft", async () => {
    const { calls } = setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await sendDraftByIdViaProvider(provider, "draft00abc123");

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("draft00abc123");
    const sendCall = calls.find((c) => c.includes("messages/send"));
    expect(sendCall).toBeDefined();
  });
});

describe("reply.ts with SuperhumanProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function setupMockFetch() {
    const calls: string[] = [];
    const mockFn = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      calls.push(urlStr);

      if (urlStr.includes("userdata.writeMessage")) {
        return Promise.resolve(
          new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })
        );
      }
      if (urlStr.includes("messages/send")) {
        return Promise.resolve(
          new Response(JSON.stringify({ send_at: Date.now() }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      if (urlStr.includes("userdata.getThreads")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              threadList: [
                {
                  thread: {
                    messages: {
                      msg1: {
                        id: "msg1",
                        subject: "Original Subject",
                        from: "sender@example.com",
                        to: ["user@example.com"],
                        date: "2026-03-20T12:00:00Z",
                        snippet: "Original message content",
                      },
                    },
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })
      );
    });
    globalThis.fetch = mockFn as any;
    return { mockFn, calls };
  }

  // ---- replyToThread ----

  test("replyToThread with SuperhumanProvider creates reply draft (no send)", async () => {
    const { calls } = setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await replyToThread(provider, "thread123", "Thanks!", false);

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    // Should create draft but NOT send
    const writeCall = calls.find((c) => c.includes("userdata.writeMessage"));
    const sendCall = calls.find((c) => c.includes("messages/send"));
    expect(writeCall).toBeDefined();
    expect(sendCall).toBeUndefined();
  });

  test("replyToThread with SuperhumanProvider sends when send=true", async () => {
    const { calls } = setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await replyToThread(provider, "thread123", "Thanks!", true);

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    // Should create draft AND send
    const writeCall = calls.find((c) => c.includes("userdata.writeMessage"));
    const sendCall = calls.find((c) => c.includes("messages/send"));
    expect(writeCall).toBeDefined();
    expect(sendCall).toBeDefined();
  });

  // ---- replyAllToThread ----

  test("replyAllToThread with SuperhumanProvider creates reply", async () => {
    setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await replyAllToThread(provider, "thread456", "Noted!", true);

    expect(result.success).toBe(true);
  });

  // ---- forwardThread ----

  test("forwardThread with SuperhumanProvider reads thread and creates forward draft", async () => {
    const { calls } = setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await forwardThread(
      provider,
      "thread789",
      "forward@example.com",
      "FYI",
      false
    );

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    // Should read thread via getThreads, then create draft
    const getCall = calls.find((c) => c.includes("userdata.getThreads"));
    const writeCall = calls.find((c) => c.includes("userdata.writeMessage"));
    expect(getCall).toBeDefined();
    expect(writeCall).toBeDefined();
  });

  test("forwardThread with SuperhumanProvider sends when send=true", async () => {
    const { calls } = setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await forwardThread(
      provider,
      "thread789",
      "forward@example.com",
      "Please see below",
      true
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    // Should read thread, create draft, AND send
    const sendCall = calls.find((c) => c.includes("messages/send"));
    expect(sendCall).toBeDefined();
  });
});
