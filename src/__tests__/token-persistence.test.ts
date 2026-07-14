import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Test with a temp directory to avoid polluting user's config
const TEST_CONFIG_DIR = "/tmp/superhuman-cli-test";
const TEST_TOKENS_FILE = join(TEST_CONFIG_DIR, "tokens.json");

// We'll need to set this env var before importing the module
process.env.SUPERHUMAN_CLI_CONFIG_DIR = TEST_CONFIG_DIR;

// Import after setting env var
import {
  saveTokensToDisk,
  loadTokensFromDisk,
  hasValidCachedTokens,
  clearTokenCache,
  setTokenCacheForTest,
  getCachedTokenRaw,
  type TokenInfo,
  type PersistedTokens,
} from "../token-api";

describe("token persistence", () => {
  beforeEach(async () => {
    // Clean up test directory
    try {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    } catch {
      // Directory might not exist
    }
    await mkdir(TEST_CONFIG_DIR, { recursive: true });

    // Clear in-memory cache
    clearTokenCache();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    } catch {
      // Directory might not exist
    }
  });

  describe("saveTokensToDisk", () => {
    test("saves tokens to JSON file", async () => {
      // Set up test tokens in cache
      const token1: TokenInfo = {
        accessToken: "test-token-1",
        email: "test1@example.com",
        expires: Date.now() + 3600000, // 1 hour from now
        isMicrosoft: false,
      };

      const token2: TokenInfo = {
        accessToken: "test-token-2",
        email: "test2@outlook.com",
        expires: Date.now() + 3600000,
        isMicrosoft: true,
      };

      setTokenCacheForTest(token1.email, token1);
      setTokenCacheForTest(token2.email, token2);

      // Save to disk
      await saveTokensToDisk();

      // Verify file exists and has correct content
      const file = Bun.file(TEST_TOKENS_FILE);
      expect(await file.exists()).toBe(true);

      const data = (await file.json()) as PersistedTokens;
      expect(data.version).toBe(1);
      expect(data.accounts["test1@example.com"]).toBeDefined();
      expect(data.accounts["test1@example.com"]!.type).toBe("google");
      expect(data.accounts["test1@example.com"]!.accessToken).toBe(
        "test-token-1"
      );
      expect(data.accounts["test2@outlook.com"]).toBeDefined();
      expect(data.accounts["test2@outlook.com"]!.type).toBe("microsoft");
      expect(data.lastUpdated).toBeGreaterThan(0);
    });

    test("creates config directory if it doesn't exist", async () => {
      // Remove the test directory
      await rm(TEST_CONFIG_DIR, { recursive: true });

      const token: TokenInfo = {
        accessToken: "test-token",
        email: "test@example.com",
        expires: Date.now() + 3600000,
        isMicrosoft: false,
      };

      setTokenCacheForTest(token.email, token);

      // Should create directory and save
      await saveTokensToDisk();

      const file = Bun.file(TEST_TOKENS_FILE);
      expect(await file.exists()).toBe(true);
    });
  });

  describe("loadTokensFromDisk", () => {
    test("loads tokens from JSON file into cache", async () => {
      // Write test data directly to file
      const testData: PersistedTokens = {
        version: 1,
        accounts: {
          "loaded@example.com": {
            type: "google",
            accessToken: "loaded-token",
            expires: Date.now() + 3600000,
          },
        },
        lastUpdated: Date.now(),
      };

      await Bun.write(TEST_TOKENS_FILE, JSON.stringify(testData));

      // Load from disk
      const loaded = await loadTokensFromDisk();
      expect(loaded).toBe(true);

      // Verify token is now in cache
      expect(hasValidCachedTokens()).toBe(true);
    });

    test("returns false when file doesn't exist", async () => {
      const loaded = await loadTokensFromDisk();
      expect(loaded).toBe(false);
    });

    test("returns false on invalid JSON", async () => {
      await Bun.write(TEST_TOKENS_FILE, "not valid json");

      const loaded = await loadTokensFromDisk();
      expect(loaded).toBe(false);
    });
  });

  describe("hasValidCachedTokens", () => {
    test("returns false when cache is empty", () => {
      clearTokenCache();
      expect(hasValidCachedTokens()).toBe(false);
    });

    test("returns true when all tokens are valid", () => {
      const token: TokenInfo = {
        accessToken: "valid-token",
        email: "valid@example.com",
        expires: Date.now() + 3600000, // 1 hour from now
        isMicrosoft: false,
      };

      setTokenCacheForTest(token.email, token);
      expect(hasValidCachedTokens()).toBe(true);
    });

    test("returns false when any token is expired", () => {
      const validToken: TokenInfo = {
        accessToken: "valid-token",
        email: "valid@example.com",
        expires: Date.now() + 3600000,
        isMicrosoft: false,
      };

      const expiredToken: TokenInfo = {
        accessToken: "expired-token",
        email: "expired@example.com",
        expires: Date.now() - 1000, // Expired 1 second ago
        isMicrosoft: false,
      };

      setTokenCacheForTest(validToken.email, validToken);
      setTokenCacheForTest(expiredToken.email, expiredToken);

      expect(hasValidCachedTokens()).toBe(false);
    });

    test("returns false when token expires within 5 minutes", () => {
      const soonToExpireToken: TokenInfo = {
        accessToken: "expiring-token",
        email: "expiring@example.com",
        expires: Date.now() + 2 * 60 * 1000, // Expires in 2 minutes
        isMicrosoft: false,
      };

      setTokenCacheForTest(soonToExpireToken.email, soonToExpireToken);

      expect(hasValidCachedTokens()).toBe(false);
    });
  });

  describe("getCachedTokenRaw", () => {
    test("returns token without expiry check", () => {
      const expiredToken: TokenInfo = {
        accessToken: "expired-token",
        email: "expired@example.com",
        expires: Date.now() - 3600000, // Expired 1 hour ago
        isMicrosoft: false,
      };

      setTokenCacheForTest(expiredToken.email, expiredToken);

      const result = getCachedTokenRaw("expired@example.com");
      expect(result).toBeDefined();
      expect(result!.accessToken).toBe("expired-token");
    });

    test("returns undefined for unknown email", () => {
      const result = getCachedTokenRaw("unknown@example.com");
      expect(result).toBeUndefined();
    });

    test("returns correct isMicrosoft flag", () => {
      const googleToken: TokenInfo = {
        accessToken: "google-token",
        email: "user@gmail.com",
        expires: Date.now() + 3600000,
        isMicrosoft: false,
      };

      const msToken: TokenInfo = {
        accessToken: "ms-token",
        email: "user@outlook.com",
        expires: Date.now() + 3600000,
        isMicrosoft: true,
      };

      setTokenCacheForTest(googleToken.email, googleToken);
      setTokenCacheForTest(msToken.email, msToken);

      expect(getCachedTokenRaw("user@gmail.com")!.isMicrosoft).toBe(false);
      expect(getCachedTokenRaw("user@outlook.com")!.isMicrosoft).toBe(true);
    });
  });

  describe("round-trip persistence", () => {
    test("saves and loads tokens correctly", async () => {
      const originalToken: TokenInfo = {
        accessToken: "roundtrip-token",
        email: "roundtrip@example.com",
        expires: Date.now() + 3600000,
        isMicrosoft: true,
      };

      // Save
      setTokenCacheForTest(originalToken.email, originalToken);
      await saveTokensToDisk();

      // Clear cache
      clearTokenCache();
      expect(hasValidCachedTokens()).toBe(false);

      // Load
      const loaded = await loadTokensFromDisk();
      expect(loaded).toBe(true);
      expect(hasValidCachedTokens()).toBe(true);
    });
  });
});
