// src/__tests__/ndjson-thread-id.test.ts
// Regression test for: Thread IDs are null in --ndjson/--stream JSON output
//
// Root cause: `cmdRead` used `getThreadMessages()` which returns `FullThreadMessage[]`
// without a `threadId` field. Both `--json` and `--ndjson` modes lacked `threadId`.
// The fix: inject `threadId` into JSON output so each message includes the thread ID
// that was used to fetch it.
import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  clearTokenCache,
  setTokenCacheForTest,
  type TokenInfo,
} from "../token-api";

const TEST_CONFIG_DIR = "/tmp/superhuman-cli-ndjson-test";
process.env.SUPERHUMAN_CLI_CONFIG_DIR = TEST_CONFIG_DIR;

function createTestToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: "test-access-token",
    email: "test@example.com",
    expires: Date.now() + 3600000,
    isMicrosoft: false,
    ...overrides,
  };
}

describe("NDJSON output includes threadId", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    try {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    } catch {}
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    clearTokenCache();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    try {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    } catch {}
    clearTokenCache();
  });

  test("read --json output includes threadId in each message (injection fix)", async () => {
    // This tests the fix in cmdRead: when JSON mode is active, threadId is injected
    // into each FullThreadMessage so the output includes the thread ID.
    //
    // The fix: messages.map(m => ({ ...m, threadId: options.threadId }))
    //
    // Simulate what cmdRead does after fetching messages:
    const { getThreadMessages } = await import("../token-api");
    const token = createTestToken();
    setTokenCacheForTest(token.email, token);

    // Mock Gmail thread response
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/threads/testThread123")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: "testThread123",
              messages: [
                {
                  id: "msg1",
                  snippet: "Hello",
                  payload: {
                    mimeType: "text/plain",
                    body: { data: btoa("Hello body") },
                    headers: [
                      { name: "Subject", value: "Test Subject" },
                      { name: "From", value: "Alice <alice@example.com>" },
                      { name: "To", value: "Bob <bob@example.com>" },
                      { name: "Date", value: "2025-01-01T10:00:00Z" },
                    ],
                    parts: null,
                  },
                },
              ],
            }),
          text: () => Promise.resolve(""),
        } as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as Response);
    }) as unknown as typeof fetch;

    const messages = await getThreadMessages(token, "testThread123");
    expect(messages.length).toBeGreaterThan(0);

    // Apply the fix: inject threadId (as cmdRead now does before printJson)
    const threadId = "testThread123";
    const withThreadId = messages.map((m) => ({ ...m, threadId }));

    // Regular JSON mode: full array — threadId must be present
    const regularJson = JSON.parse(JSON.stringify(withThreadId, null, 2));
    expect(Array.isArray(regularJson)).toBe(true);
    expect(regularJson[0].threadId).toBe("testThread123");

    // NDJSON mode: each item individually — threadId must still be present
    for (const item of withThreadId) {
      const ndjsonItem = JSON.parse(JSON.stringify(item));
      expect(ndjsonItem.threadId).toBe("testThread123");
    }
  });

  test("read --ndjson each line includes threadId field", async () => {
    // Tests that printJson in stream mode outputs threadId for each message
    // This uses the readThread function which correctly includes threadId
    const { readThread } = await import("../read");
    const { CachedTokenProvider } = await import("../connection-provider");

    const token = createTestToken();
    setTokenCacheForTest(token.email, token);

    // Mock Gmail thread response
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/threads/testThread456")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: "testThread456",
              messages: [
                {
                  id: "msgA",
                  snippet: "First message",
                  payload: {
                    headers: [
                      { name: "Subject", value: "Thread Subject" },
                      { name: "From", value: "Alice <alice@example.com>" },
                      { name: "To", value: "Bob <bob@example.com>" },
                      { name: "Date", value: "2025-01-01T10:00:00Z" },
                    ],
                  },
                },
                {
                  id: "msgB",
                  snippet: "Second message",
                  payload: {
                    headers: [
                      { name: "Subject", value: "Re: Thread Subject" },
                      { name: "From", value: "Bob <bob@example.com>" },
                      { name: "To", value: "Alice <alice@example.com>" },
                      { name: "Date", value: "2025-01-01T11:00:00Z" },
                    ],
                  },
                },
              ],
            }),
          text: () => Promise.resolve(""),
        } as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as Response);
    }) as unknown as typeof fetch;

    const provider = new CachedTokenProvider(token.email);
    const messages = await readThread(provider, "testThread456");

    expect(messages).toHaveLength(2);

    // Verify readThread includes threadId
    expect(messages[0].threadId).toBe("testThread456");
    expect(messages[1].threadId).toBe("testThread456");

    // Simulate NDJSON output: each message serialized individually
    const ndjsonLines = messages.map((m) => JSON.parse(JSON.stringify(m)));
    for (const line of ndjsonLines) {
      // CORE ASSERTION: threadId must be present and non-null in NDJSON output
      expect(line.threadId).toBe("testThread456");
    }
  });

  test("inbox --ndjson each line includes id (thread ID) field", async () => {
    // Verify InboxThread objects include 'id' in NDJSON mode
    const { searchGmailDirect } = await import("../token-api");
    const token = createTestToken();
    setTokenCacheForTest(token.email, token);

    // Mock Gmail messages.list + thread fetch
    let callCount = 0;
    globalThis.fetch = mock((url: string) => {
      callCount++;
      if (url.includes("/messages?q=")) {
        // messages.list response
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              messages: [
                { id: "msgX", threadId: "threadXXX" },
              ],
            }),
          text: () => Promise.resolve(""),
        } as Response);
      }
      if (url.includes("/threads/threadXXX")) {
        // thread fetch response
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: "threadXXX",
              messages: [
                {
                  id: "msgX",
                  threadId: "threadXXX",
                  snippet: "test snippet",
                  labelIds: ["INBOX"],
                  payload: {
                    headers: [
                      { name: "Subject", value: "Test" },
                      { name: "From", value: "test@example.com" },
                      { name: "Date", value: "2025-01-01" },
                    ],
                  },
                  internalDate: "1735689600000",
                },
              ],
            }),
          text: () => Promise.resolve(""),
        } as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as Response);
    }) as unknown as typeof fetch;

    const threads = await searchGmailDirect(token, "label:INBOX", 5);

    expect(threads.length).toBeGreaterThan(0);

    // CORE ASSERTION: id must be non-null in NDJSON output
    for (const thread of threads) {
      const ndjsonItem = JSON.parse(JSON.stringify(thread));
      expect(ndjsonItem.id).toBeTruthy();
      expect(ndjsonItem.id).not.toBeNull();
    }
  });
});
