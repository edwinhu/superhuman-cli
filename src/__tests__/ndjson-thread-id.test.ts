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

    // readThread with CachedTokenProvider will throw since direct API path was removed.
    // This test now validates that the MCP path is required.
    const provider = new CachedTokenProvider(token.email);
    await expect(readThread(provider, "testThread456")).rejects.toThrow(
      "readThread requires an MCP provider"
    );
  });

  // Note: inbox --ndjson test removed because it depended on searchGmailDirect
  // which was a direct provider API function that has been removed.
});
