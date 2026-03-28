import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  saveTokensToDisk,
  loadTokensFromDisk,
  clearTokenCache,
  setTokenCacheForTest,
  getCachedToken,
  refreshAccessToken,
  type TokenInfo
} from "../token-api";
import { mkdir, rm } from "node:fs/promises";

describe("token-refresh", () => {
  describe("TokenInfo interface", () => {
    test("TokenInfo accepts refreshToken field", () => {
      const token: TokenInfo = {
        accessToken: "test-access-token",
        email: "test@example.com",
        expires: Date.now() + 3600000,
        isMicrosoft: false,
        refreshToken: "test-refresh-token",
      };

      expect(token.refreshToken).toBe("test-refresh-token");
    });

    test("TokenInfo refreshToken is optional", () => {
      const token: TokenInfo = {
        accessToken: "test-access-token",
        email: "test@example.com",
        expires: Date.now() + 3600000,
        isMicrosoft: false,
      };

      expect(token.refreshToken).toBeUndefined();
    });
  });
});

const TEST_CONFIG_DIR = "/tmp/superhuman-cli-test-refresh";

describe("token persistence with refreshToken", () => {
  beforeEach(async () => {
    process.env.SUPERHUMAN_CLI_CONFIG_DIR = TEST_CONFIG_DIR;
    try {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    } catch {}
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    clearTokenCache();
  });

  afterEach(async () => {
    try {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    } catch {}
  });

  test("saves and loads refreshToken from disk", async () => {
    const token: TokenInfo = {
      accessToken: "test-access",
      email: "test@example.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
      refreshToken: "test-refresh-token-123",
    };

    setTokenCacheForTest(token.email, token);
    await saveTokensToDisk();

    // Clear cache and reload
    clearTokenCache();
    await loadTokensFromDisk();

    const loaded = await getCachedToken(token.email);
    expect(loaded?.refreshToken).toBe("test-refresh-token-123");
  });

  test("handles tokens without refreshToken", async () => {
    const token: TokenInfo = {
      accessToken: "test-access",
      email: "no-refresh@example.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
      // No refreshToken
    };

    setTokenCacheForTest(token.email, token);
    await saveTokensToDisk();

    clearTokenCache();
    await loadTokensFromDisk();

    const loaded = await getCachedToken(token.email);
    expect(loaded?.refreshToken).toBeUndefined();
  });
});

describe("getCachedToken auto-refresh", () => {
  beforeEach(async () => {
    process.env.SUPERHUMAN_CLI_CONFIG_DIR = TEST_CONFIG_DIR;
    try {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    } catch {}
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    clearTokenCache();
  });

  afterEach(async () => {
    try {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    } catch {}
  });

  test("returns valid token without refresh", async () => {
    const token: TokenInfo = {
      accessToken: "valid-access",
      email: "test@example.com",
      expires: Date.now() + 3600000, // 1 hour from now
      isMicrosoft: false,
    };

    setTokenCacheForTest(token.email, token);

    const result = await getCachedToken(token.email);
    expect(result?.accessToken).toBe("valid-access");
  });

  test("refreshes expiring token automatically", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        access_token: "refreshed-access-token",
        expires_in: 3600,
      }), { status: 200 });
    };

    try {
      const token: TokenInfo = {
        accessToken: "old-access",
        email: "expiring@example.com",
        expires: Date.now() + (2 * 60 * 1000), // 2 minutes (within 5-min buffer)
        isMicrosoft: false,
        refreshToken: "valid-refresh-token",
      };

      setTokenCacheForTest(token.email, token);

      const result = await getCachedToken(token.email);

      expect(result?.accessToken).toBe("refreshed-access-token");
      expect(result?.expires).toBeGreaterThan(Date.now() + 3000000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns undefined for expired token without refreshToken", async () => {
    const token: TokenInfo = {
      accessToken: "expired-access",
      email: "no-refresh@example.com",
      expires: Date.now() - 1000, // expired
      isMicrosoft: false,
      // No refreshToken
    };

    setTokenCacheForTest(token.email, token);

    const result = await getCachedToken(token.email);
    expect(result).toBeUndefined();
  });

  test("persists refreshed token to disk", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        access_token: "persisted-access-token",
        expires_in: 3600,
      }), { status: 200 });
    };

    try {
      const token: TokenInfo = {
        accessToken: "old-access",
        email: "persist-test@example.com",
        expires: Date.now() + (2 * 60 * 1000),
        isMicrosoft: false,
        refreshToken: "persist-refresh-token",
      };

      setTokenCacheForTest(token.email, token);

      await getCachedToken(token.email);

      // Clear cache and reload from disk
      clearTokenCache();
      await loadTokensFromDisk();

      const loaded = await getCachedToken(token.email);
      expect(loaded?.accessToken).toBe("persisted-access-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("refreshAccessToken", () => {
  test("returns null if no refreshToken", async () => {
    const token: TokenInfo = {
      accessToken: "old-access",
      email: "test@example.com",
      expires: Date.now() - 1000, // expired
      isMicrosoft: false,
      // No refreshToken
    };

    const result = await refreshAccessToken(token);
    expect(result).toBeNull();
  });

  test("calls Google OAuth endpoint for Google accounts", async () => {
    // This test verifies the endpoint is called correctly
    // We mock fetch to avoid actual network calls
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody = "";

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedBody = init?.body?.toString() || "";
      return new Response(JSON.stringify({
        access_token: "new-access-token",
        expires_in: 3600,
        refresh_token: "new-refresh-token",
      }), { status: 200 });
    };

    try {
      const token: TokenInfo = {
        accessToken: "old-access",
        email: "test@gmail.com",
        expires: Date.now() - 1000,
        isMicrosoft: false,
        refreshToken: "test-refresh-token",
      };

      const result = await refreshAccessToken(token);

      expect(capturedUrl).toBe("https://oauth2.googleapis.com/token");
      expect(capturedBody).toContain("grant_type=refresh_token");
      expect(capturedBody).toContain("refresh_token=test-refresh-token");
      expect(capturedBody).toContain("client_id=649336022844");
      expect(result?.accessToken).toBe("new-access-token");
      expect(result?.refreshToken).toBe("new-refresh-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("calls Microsoft OAuth endpoint for Microsoft accounts", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody = "";

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedBody = init?.body?.toString() || "";
      return new Response(JSON.stringify({
        access_token: "ms-new-access",
        expires_in: 3600,
      }), { status: 200 });
    };

    try {
      const token: TokenInfo = {
        accessToken: "old-access",
        email: "test@outlook.com",
        expires: Date.now() - 1000,
        isMicrosoft: true,
        refreshToken: "ms-refresh-token",
      };

      const result = await refreshAccessToken(token);

      expect(capturedUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
      expect(capturedBody).toContain("client_id=d8404a9f");
      expect(result?.accessToken).toBe("ms-new-access");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns null on HTTP error", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      return new Response("Unauthorized", { status: 401 });
    };

    try {
      const token: TokenInfo = {
        accessToken: "old-access",
        email: "test@gmail.com",
        expires: Date.now() - 1000,
        isMicrosoft: false,
        refreshToken: "bad-refresh-token",
      };

      const result = await refreshAccessToken(token);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("error handling", () => {
  beforeEach(async () => {
    process.env.SUPERHUMAN_CLI_CONFIG_DIR = TEST_CONFIG_DIR;
    try {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    } catch {}
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    clearTokenCache();
  });

  afterEach(async () => {
    try {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    } catch {}
  });

  test("logs warning when token expires without refresh", async () => {
    const originalWarn = console.warn;
    let warnMessage = "";
    console.warn = (msg: string) => { warnMessage = msg; };

    try {
      const token: TokenInfo = {
        accessToken: "expired-access",
        email: "warn-test@example.com",
        expires: Date.now() - 1000, // expired
        isMicrosoft: false,
        // No refreshToken
      };

      setTokenCacheForTest(token.email, token);

      await getCachedToken(token.email);

      expect(warnMessage).toContain("warn-test@example.com");
      expect(warnMessage).toContain("superhuman auth");
    } finally {
      console.warn = originalWarn;
    }
  });
});
