import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, rm } from "node:fs/promises";

const TEST_CONFIG_DIR = "/tmp/superhuman-cli-read-test";
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
    email: "test@example.com",
    expires: Date.now() + 3600000,
    isMicrosoft: false,
    ...overrides,
  };
}

describe("readThread", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    try { await rm(TEST_CONFIG_DIR, { recursive: true }); } catch {}
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    clearTokenCache();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    try { await rm(TEST_CONFIG_DIR, { recursive: true }); } catch {}
    clearTokenCache();
  });

  test("readThread requires MCP provider (CachedTokenProvider throws)", async () => {
    const token = createTestToken();
    setTokenCacheForTest(token.email, token);
    const provider = new CachedTokenProvider(token.email);

    const { readThread } = await import("../read");
    await expect(readThread(provider, "thread123")).rejects.toThrow(
      "readThread requires an MCP provider"
    );
  });

  test("readThread requires MCP provider for MS Graph too", async () => {
    const token = createTestToken({ isMicrosoft: true });
    setTokenCacheForTest(token.email, token);
    const provider = new CachedTokenProvider(token.email);

    const { readThread } = await import("../read");
    await expect(readThread(provider, "convABC")).rejects.toThrow(
      "readThread requires an MCP provider"
    );
  });
});
