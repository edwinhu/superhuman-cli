/**
 * Regression test: Replies must thread with original conversation.
 *
 * Bug: `replyViaSuperhuman` in reply.ts passed `inReplyTo: undefined` and
 * `references: []` hardcoded to `sendDraftSuperhuman`. Without these headers,
 * the outgoing email has no `In-Reply-To` or `References` headers, so mail
 * clients start a new thread instead of threading with the original.
 *
 * Fix: Fetch the original thread's last message RFC822 ID and references chain
 * from local SQLite before creating the draft, and pass them through to both
 * `createDraftWithUserInfo` and `sendDraftSuperhuman`.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { SuperhumanProvider } from "../superhuman-provider";
import type { SuperhumanTokenInfo } from "../superhuman-provider";
import { replyToThread, replyAllToThread, _testHooks } from "../reply";

const sampleToken: SuperhumanTokenInfo = {
  token: "test-jwt-token",
  email: "user@example.com",
  accountId: "acct_123",
  expires: Date.now() + 3600_000,
};

const ORIGINAL_MESSAGE_ID = "<original-msg-id@mail.example.com>";
const ORIGINAL_REFERENCES = [
  "<first-msg@mail.example.com>",
  "<second-msg@mail.example.com>",
];

/** SQLite thread data matching what readThreadFromDB returns. */
function makeSQLiteThread() {
  return {
    messages: [
      {
        id: "msg1",
        subject: "Original Subject",
        from: "sender@example.com",
        to: ["user@example.com"],
        rfc822Id: ORIGINAL_MESSAGE_ID,
        messageId: ORIGINAL_MESSAGE_ID,
        references: ORIGINAL_REFERENCES,
        date: "2026-03-20T12:00:00Z",
        snippet: "Original message content",
      },
    ],
  };
}

describe("reply threading headers (regression: replies must thread with original)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalGetThreadData: typeof _testHooks.getThreadData;
  let capturedSendBodies: any[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalGetThreadData = _testHooks.getThreadData;
    capturedSendBodies = [];
    // Override the thread data fetcher to return mock data (no mock.module needed)
    _testHooks.getThreadData = () => makeSQLiteThread();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _testHooks.getThreadData = originalGetThreadData;
  });

  function setupMockFetch() {
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr =
        typeof url === "string"
          ? url
          : url instanceof URL
          ? url.toString()
          : (url as Request).url;

      // Draft write — succeed silently
      if (urlStr.includes("userdata.writeMessage")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // messages/send — capture body for assertion
      if (urlStr.includes("messages/send") && !urlStr.includes("/log")) {
        if (init?.body) {
          capturedSendBodies.push(JSON.parse(init.body as string));
        }
        return new Response(JSON.stringify({ send_at: Date.now() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // messages/send/log — succeed silently
      if (urlStr.includes("messages/send/log")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    };
  }

  test("replyToThread: send payload includes in_reply_to from original message", async () => {
    setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await replyToThread(provider, "thread123", "Thanks!", true);

    expect(result.success).toBe(true);
    expect(capturedSendBodies.length).toBeGreaterThan(0);

    const payload = capturedSendBodies[0];
    const msg = payload.outgoing_message;

    // The in_reply_to field in the payload must be the original message's RFC822 ID
    expect(msg.in_reply_to).toBe(ORIGINAL_MESSAGE_ID);
  });

  test("replyToThread: send payload includes In-Reply-To header from original message", async () => {
    setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await replyToThread(provider, "thread123", "Thanks!", true);

    expect(result.success).toBe(true);
    const payload = capturedSendBodies[0];
    const headers: Array<{ name: string; value: string }> =
      payload.outgoing_message.headers;

    const inReplyToHeader = headers.find((h) => h.name === "In-Reply-To");
    expect(inReplyToHeader).toBeDefined();
    expect(inReplyToHeader!.value).toBe(ORIGINAL_MESSAGE_ID);
  });

  test("replyToThread: send payload includes References header from original message", async () => {
    setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await replyToThread(provider, "thread123", "Thanks!", true);

    expect(result.success).toBe(true);
    const payload = capturedSendBodies[0];
    const headers: Array<{ name: string; value: string }> =
      payload.outgoing_message.headers;

    const refsHeader = headers.find((h) => h.name === "References");
    expect(refsHeader).toBeDefined();
    // References chain must include the original message's references
    for (const ref of ORIGINAL_REFERENCES) {
      expect(refsHeader!.value).toContain(ref);
    }
  });

  test("replyAllToThread: send payload includes in_reply_to from original message", async () => {
    setupMockFetch();
    const provider = new SuperhumanProvider(sampleToken);

    const result = await replyAllToThread(provider, "thread123", "Thanks all!", true);

    expect(result.success).toBe(true);
    expect(capturedSendBodies.length).toBeGreaterThan(0);

    const payload = capturedSendBodies[0];
    const msg = payload.outgoing_message;

    expect(msg.in_reply_to).toBe(ORIGINAL_MESSAGE_ID);
  });

  test("replyToThread: draft write includes inReplyToRfc822Id from original message", async () => {
    const capturedDraftBodies: any[] = [];
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr =
        typeof url === "string"
          ? url
          : url instanceof URL
          ? url.toString()
          : (url as Request).url;

      if (urlStr.includes("userdata.writeMessage")) {
        if (init?.body) {
          capturedDraftBodies.push(JSON.parse(init.body as string));
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    };

    const provider = new SuperhumanProvider(sampleToken);
    await replyToThread(provider, "thread123", "Thanks!", false);

    expect(capturedDraftBodies.length).toBeGreaterThan(0);
    const draftWrite = capturedDraftBodies[0];
    const draftValue = draftWrite.writes[0].value;

    // The draft must store inReplyToRfc822Id so Superhuman can display threading
    expect(draftValue.inReplyToRfc822Id).toBe(ORIGINAL_MESSAGE_ID);
  });
});
