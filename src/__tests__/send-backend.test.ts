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
import { replyToThread, replyAllToThread, forwardThread, _testHooks } from "../reply";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

  /** Capture the JSON body of the /messages/send POST for payload assertions. */
  function setupCapturingMockFetch() {
    const calls: string[] = [];
    let sendBody: any = null;
    const mockFn = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr =
        typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      calls.push(urlStr);
      if (urlStr.includes("messages/send") && !urlStr.includes("/log")) {
        try {
          sendBody = JSON.parse((init?.body as string) ?? "{}");
        } catch {
          sendBody = null;
        }
        return Promise.resolve(
          new Response(JSON.stringify({ send_at: Date.now() }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })
      );
    });
    globalThis.fetch = mockFn as any;
    return { calls, getSendBody: () => sendBody };
  }

  test("sendDraftByIdViaProvider sends the full cached payload (recipients, body, attachment, threading)", async () => {
    // Isolate the draft cache to a temp dir so loadDraftMeta() reads our fixture.
    const tmp = mkdtempSync(join(tmpdir(), "sh-cli-draft-"));
    const prevCfg = process.env.SUPERHUMAN_CLI_CONFIG_DIR;
    process.env.SUPERHUMAN_CLI_CONFIG_DIR = tmp;
    try {
      const draftId = "draft00abc123";
      const meta = {
        draftId,
        threadId: "AAQkThreadRealId==",
        to: ["Reynolds W. Holding <rh2804@columbia.edu>"],
        subject: "Re: Mirror Voting",
        htmlBody: "<p>Hi Ren,</p>",
        inReplyTo: "<orig@mail.gmail.com>",
        inReplyToItemId: "AAkItem3",
        references: ["<r1@x.com>"],
        createdAt: new Date().toISOString(),
        replyItemIds: ["AAkItem1", "AAkItem2", "AAkItem3"],
        attachments: [
          {
            uuid: "uuid-1",
            name: "post.docx",
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            inline: false,
            downloadUrl: "https://media.superhuman.com/x",
            cid: "cid-1",
            threadId: "AAQkThreadRealId==",
            messageId: draftId,
            size: 1234,
          },
        ],
      };
      writeFileSync(join(tmp, "draft-cache.json"), JSON.stringify({ [draftId]: meta }));

      const { calls, getSendBody } = setupCapturingMockFetch();
      const provider = new SuperhumanProvider(sampleToken);

      const result = await sendDraftByIdViaProvider(provider, draftId);

      expect(result.success).toBe(true);
      expect(result.messageId).toBe(draftId);
      expect(calls.find((c) => c.includes("messages/send"))).toBeDefined();

      const om = getSendBody()?.outgoing_message;
      expect(om).toBeTruthy();
      // Real thread id — NOT the draft id (the old bug used draftId here).
      expect(om.thread_id).toBe("AAQkThreadRealId==");
      // Recipients carried through (old bug sent to:[]).
      expect(om.to).toEqual([{ email: "rh2804@columbia.edu", name: "Reynolds W. Holding" }]);
      expect(om.subject).toBe("Re: Mirror Voting");
      expect(om.html_body).toBe("<p>Hi Ren,</p>");
      // Reply threading + the silent-failure fix.
      expect(om.in_reply_to).toBe("AAkItem3");
      expect(om.current_message_ids).toEqual(["AAkItem1", "AAkItem2", "AAkItem3", draftId]);
      // Attachment re-included.
      expect(om.attachments).toHaveLength(1);
      expect(om.attachments[0].uuid).toBe("uuid-1");
      expect(om.attachments[0].source.message_id).toBe(draftId);
    } finally {
      if (prevCfg === undefined) delete process.env.SUPERHUMAN_CLI_CONFIG_DIR;
      else process.env.SUPERHUMAN_CLI_CONFIG_DIR = prevCfg;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("sendDraftByIdViaProvider refuses when no cached metadata exists (no blind empty send)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sh-cli-draft-"));
    const prevCfg = process.env.SUPERHUMAN_CLI_CONFIG_DIR;
    process.env.SUPERHUMAN_CLI_CONFIG_DIR = tmp; // empty cache dir
    try {
      const { calls } = setupCapturingMockFetch();
      const provider = new SuperhumanProvider(sampleToken);

      const result = await sendDraftByIdViaProvider(provider, "draft00missing");

      expect(result.success).toBe(false);
      expect(result.error).toContain("No cached metadata");
      // Must NOT have hit the send endpoint.
      expect(calls.find((c) => c.includes("messages/send"))).toBeUndefined();
    } finally {
      if (prevCfg === undefined) delete process.env.SUPERHUMAN_CLI_CONFIG_DIR;
      else process.env.SUPERHUMAN_CLI_CONFIG_DIR = prevCfg;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("sendDraftByIdViaProvider refuses a reply whose only thread id is the conversation id", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sh-cli-draft-"));
    const prevCfg = process.env.SUPERHUMAN_CLI_CONFIG_DIR;
    process.env.SUPERHUMAN_CLI_CONFIG_DIR = tmp;
    try {
      const draftId = "draft00guard";
      writeFileSync(
        join(tmp, "draft-cache.json"),
        JSON.stringify({
          [draftId]: {
            draftId,
            threadId: "CONV==",
            to: ["a@b.com"],
            subject: "Re: x",
            htmlBody: "<p>hi</p>",
            createdAt: new Date().toISOString(),
            replyItemIds: ["CONV=="], // only the conversation id → would fail silently
          },
        })
      );
      const { calls } = setupCapturingMockFetch();
      const provider = new SuperhumanProvider(sampleToken);

      const result = await sendDraftByIdViaProvider(provider, draftId);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Refusing to send");
      expect(calls.find((c) => c.includes("messages/send"))).toBeUndefined();
    } finally {
      if (prevCfg === undefined) delete process.env.SUPERHUMAN_CLI_CONFIG_DIR;
      else process.env.SUPERHUMAN_CLI_CONFIG_DIR = prevCfg;
      rmSync(tmp, { recursive: true, force: true });
    }
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
