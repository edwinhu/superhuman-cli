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
} from "../send-api";
import { buildSendDraftOptions, type Recipient, type SuperhumanAttachment } from "../draft-api";
import { replyToThread, replyAllToThread, forwardThread, _testHooks } from "../reply";

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

});

describe("reply.ts with SuperhumanProvider", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalGetThreadData: typeof _testHooks.getThreadData;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalGetThreadData = _testHooks.getThreadData;
    // Override thread data fetcher — reply/forward now use SQLite, not backend API
    _testHooks.getThreadData = () => ({
      messages: [
        {
          id: "msg1",
          subject: "Original Subject",
          from: "sender@example.com",
          to: ["user@example.com"],
          date: "2026-03-20T12:00:00Z",
          snippet: "Original message content",
          rfc822Id: "<msg1@example.com>",
          references: [],
        },
      ],
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _testHooks.getThreadData = originalGetThreadData;
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
    // Thread data comes from SQLite (mocked above), draft is created via fetch
    const writeCall = calls.find((c) => c.includes("userdata.writeMessage"));
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

describe("buildSendDraftOptions", () => {
  const att: SuperhumanAttachment = {
    uuid: "uuid-1",
    name: "post.docx",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    inline: false,
    downloadUrl: "https://media.superhuman.com/x",
    cid: "cid-1",
    threadId: "AAQkThreadRealId==",
    messageId: "draft00abc123",
    size: 1234,
  };
  const to: Recipient[] = [{ email: "rh2804@columbia.edu", name: "Reynolds W. Holding" }];

  test("reply: carries real threadId, recipients, attachment, and current_message_ids = [...replyItemIds, draftId]", () => {
    const r = buildSendDraftOptions({
      draftId: "draft00abc123",
      threadId: "AAQkThreadRealId==",
      to,
      subject: "Re: Mirror Voting",
      htmlBody: "<p>Hi Ren,</p>",
      inReplyTo: "<orig@mail.gmail.com>",
      inReplyToItemId: "AAkItem3",
      references: ["<r1@x.com>"],
      replyItemIds: ["AAkItem1", "AAkItem2", "AAkItem3"],
      attachments: [att],
      delay: 20,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = r.options;
    // Real thread id — NOT the draft id (the original bug used draftId here).
    expect(o.threadId).toBe("AAQkThreadRealId==");
    expect(o.to).toEqual(to);
    expect(o.subject).toBe("Re: Mirror Voting");
    expect(o.htmlBody).toBe("<p>Hi Ren,</p>");
    expect(o.inReplyToItemId).toBe("AAkItem3");
    // The silent-failure fix: prior thread ids + this draft.
    expect(o.currentMessageIds).toEqual(["AAkItem1", "AAkItem2", "AAkItem3", "draft00abc123"]);
    expect(o.attachments).toEqual([att]);
    expect(o.delay).toBe(20);
  });

  test("Gmail reply: per-message id distinct from threadId is NOT blocked by the guard", () => {
    // Regression: a Gmail reply's replyItemIds are real per-message ids, distinct
    // from the (hex) threadId, so the guard must let it through.
    const r = buildSendDraftOptions({
      draftId: "draft00gmailrep",
      threadId: "19e944aeb93de925",
      to: [{ email: "malenko@bc.edu", name: "Nadya Malenko" }],
      subject: "Re: paper",
      htmlBody: "<p>Thanks!</p>",
      inReplyToItemId: "19e951ed105d2b06",
      replyItemIds: ["19e951ed105d2b06"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.currentMessageIds).toEqual(["19e951ed105d2b06", "draft00gmailrep"]);
  });

  test("compose (no replyItemIds): current_message_ids is omitted", () => {
    const r = buildSendDraftOptions({
      draftId: "draft00compose",
      threadId: "draft00compose",
      to,
      subject: "Hello",
      htmlBody: "<p>hi</p>",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.currentMessageIds).toBeUndefined();
  });

  test("refuses an empty-recipient send (would 200 then silently never deliver)", () => {
    const r = buildSendDraftOptions({
      draftId: "draft00empty",
      threadId: "T==",
      to: [],
      subject: "x",
      htmlBody: "<p>x</p>",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("recipients");
  });

  test("refuses a reply whose only thread message id is the conversation id", () => {
    const r = buildSendDraftOptions({
      draftId: "draft00guard",
      threadId: "CONV==",
      to: [{ email: "a@b.com" }],
      subject: "Re: x",
      htmlBody: "<p>hi</p>",
      replyItemIds: ["CONV=="], // == threadId → MS no-per-message-id fallback
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Refusing to send");
  });

  test("empty cc/bcc arrays become undefined (not []), non-empty pass through", () => {
    const r = buildSendDraftOptions({
      draftId: "draft00cc",
      threadId: "T==",
      to,
      cc: [],
      bcc: [{ email: "boss@x.com" }],
      subject: "x",
      htmlBody: "<p>x</p>",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.cc).toBeUndefined();
    expect(r.options.bcc).toEqual([{ email: "boss@x.com" }]);
  });
});
