import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";

const TEST_CONFIG_DIR = "/tmp/superhuman-cli-reply-test";
process.env.SUPERHUMAN_CLI_CONFIG_DIR = TEST_CONFIG_DIR;

import { CachedTokenProvider } from "../connection-provider";
import {
  clearTokenCache,
  setTokenCacheForTest,
  type TokenInfo,
} from "../token-api";

function createTestToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: "test-access-token",
    email: "me@example.com",
    expires: Date.now() + 3600000,
    isMicrosoft: false,
    ...overrides,
  };
}

describe("reply.ts with ConnectionProvider", () => {
  beforeEach(async () => {
    try { await rm(TEST_CONFIG_DIR, { recursive: true }); } catch {}
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    clearTokenCache();
  });

  afterEach(async () => {
    try { await rm(TEST_CONFIG_DIR, { recursive: true }); } catch {}
    clearTokenCache();
  });

  test("replyToThread rejects CachedTokenProvider (requires MCP)", async () => {
    const token = createTestToken();
    setTokenCacheForTest(token.email, token);
    const provider = new CachedTokenProvider(token.email);

    const { replyToThread } = await import("../reply");
    await expect(replyToThread(provider, "thread1", "Thanks!", true)).rejects.toThrow(
      "MCP provider required"
    );
  });

  test("replyAllToThread rejects CachedTokenProvider (requires MCP)", async () => {
    const token = createTestToken();
    setTokenCacheForTest(token.email, token);
    const provider = new CachedTokenProvider(token.email);

    const { replyAllToThread } = await import("../reply");
    await expect(replyAllToThread(provider, "thread1", "Thanks all!", true)).rejects.toThrow(
      "MCP provider required"
    );
  });

  test("forwardThread rejects CachedTokenProvider (requires MCP)", async () => {
    const token = createTestToken();
    setTokenCacheForTest(token.email, token);
    const provider = new CachedTokenProvider(token.email);

    const { forwardThread } = await import("../reply");
    await expect(forwardThread(provider, "thread1", "bob@example.com", "FYI", true)).rejects.toThrow(
      "MCP provider required"
    );
  });
});
