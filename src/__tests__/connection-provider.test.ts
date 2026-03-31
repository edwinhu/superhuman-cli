import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const TEST_CONFIG_DIR = "/tmp/superhuman-cli-provider-test";
process.env.SUPERHUMAN_CLI_CONFIG_DIR = TEST_CONFIG_DIR;

import {
  CachedTokenProvider,
  CDPConnectionProvider,
  resolveProvider,
  type ConnectionProvider,
} from "../connection-provider";
import { SuperhumanProvider } from "../superhuman-provider";
import {
  clearTokenCache,
  setTokenCacheForTest,
  loadTokensFromDisk,
  type TokenInfo,
  type PersistedTokens,
} from "../token-api";

describe("CachedTokenProvider", () => {
  beforeEach(async () => {
    try { await rm(TEST_CONFIG_DIR, { recursive: true }); } catch {}
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    clearTokenCache();
  });

  afterEach(async () => {
    try { await rm(TEST_CONFIG_DIR, { recursive: true }); } catch {}
    clearTokenCache();
  });

  test("getToken returns cached token for specified email", async () => {
    const token: TokenInfo = {
      accessToken: "test-access-token",
      email: "user@example.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
    };
    setTokenCacheForTest(token.email, token);

    const provider = new CachedTokenProvider("user@example.com");
    const result = await provider.getToken();

    expect(result.accessToken).toBe("test-access-token");
    expect(result.email).toBe("user@example.com");
  });

  test("getToken returns token for first cached account when no email specified", async () => {
    const token: TokenInfo = {
      accessToken: "first-token",
      email: "first@example.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
    };
    setTokenCacheForTest(token.email, token);

    const provider = new CachedTokenProvider();
    const result = await provider.getToken();

    expect(result.accessToken).toBe("first-token");
    expect(result.email).toBe("first@example.com");
  });

  test("getToken throws when no cached tokens exist", async () => {
    const provider = new CachedTokenProvider("missing@example.com");
    await expect(provider.getToken()).rejects.toThrow();
  });

  test("getCurrentEmail returns specified email", async () => {
    const token: TokenInfo = {
      accessToken: "tok",
      email: "user@example.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
    };
    setTokenCacheForTest(token.email, token);

    const provider = new CachedTokenProvider("user@example.com");
    const email = await provider.getCurrentEmail();
    expect(email).toBe("user@example.com");
  });

  test("getCurrentEmail returns first cached email when none specified", async () => {
    const token: TokenInfo = {
      accessToken: "tok",
      email: "auto@example.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
    };
    setTokenCacheForTest(token.email, token);

    const provider = new CachedTokenProvider();
    const email = await provider.getCurrentEmail();
    expect(email).toBe("auto@example.com");
  });

  test("getAccountInfo returns correct provider type for Google", async () => {
    const token: TokenInfo = {
      accessToken: "tok",
      email: "user@gmail.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
    };
    setTokenCacheForTest(token.email, token);

    const provider = new CachedTokenProvider("user@gmail.com");
    const info = await provider.getAccountInfo();
    expect(info.email).toBe("user@gmail.com");
    expect(info.isMicrosoft).toBe(false);
    expect(info.provider).toBe("google");
  });

  test("getAccountInfo returns correct provider type for Microsoft", async () => {
    const token: TokenInfo = {
      accessToken: "tok",
      email: "user@outlook.com",
      expires: Date.now() + 3600000,
      isMicrosoft: true,
    };
    setTokenCacheForTest(token.email, token);

    const provider = new CachedTokenProvider("user@outlook.com");
    const info = await provider.getAccountInfo();
    expect(info.email).toBe("user@outlook.com");
    expect(info.isMicrosoft).toBe(true);
    expect(info.provider).toBe("microsoft");
  });

  test("disconnect is a no-op", async () => {
    const provider = new CachedTokenProvider();
    // Should not throw
    await provider.disconnect();
  });
});

describe("resolveProvider", () => {
  beforeEach(async () => {
    try { await rm(TEST_CONFIG_DIR, { recursive: true }); } catch {}
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    clearTokenCache();
  });

  afterEach(async () => {
    try { await rm(TEST_CONFIG_DIR, { recursive: true }); } catch {}
    clearTokenCache();
  });

  test("returns SuperhumanProvider when --account matches cached token with superhumanToken", async () => {
    const token: TokenInfo = {
      accessToken: "cached-tok",
      email: "user@example.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
      superhumanToken: {
        token: "sh-jwt-tok",
        expires: Date.now() + 3600000,
      },
    };
    setTokenCacheForTest(token.email, token);

    const provider = await resolveProvider({ account: "user@example.com" });
    expect(provider).toBeInstanceOf(SuperhumanProvider);
    const tok = await provider!.getToken();
    expect(tok.superhumanToken?.token).toBe("sh-jwt-tok");
  });

  test("returns CachedTokenProvider when --account matches cached token without superhumanToken", async () => {
    const token: TokenInfo = {
      accessToken: "cached-tok",
      email: "user@example.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
    };
    setTokenCacheForTest(token.email, token);

    const provider = await resolveProvider({ account: "user@example.com" });
    expect(provider).toBeInstanceOf(CachedTokenProvider);
    const tok = await provider!.getToken();
    expect(tok.accessToken).toBe("cached-tok");
  });

  test("returns SuperhumanProvider when cached tokens exist with superhumanToken (no --account)", async () => {
    const token: TokenInfo = {
      accessToken: "auto-tok",
      email: "auto@example.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
      superhumanToken: {
        token: "sh-auto-tok",
        expires: Date.now() + 3600000,
      },
    };
    setTokenCacheForTest(token.email, token);

    const provider = await resolveProvider({});
    expect(provider).toBeInstanceOf(SuperhumanProvider);
  });

  test("returns CachedTokenProvider when cached tokens exist without superhumanToken (no --account)", async () => {
    const token: TokenInfo = {
      accessToken: "auto-tok",
      email: "auto@example.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
    };
    setTokenCacheForTest(token.email, token);

    const provider = await resolveProvider({});
    expect(provider).toBeInstanceOf(CachedTokenProvider);
  });

  test("returns null when no cached tokens and no CDP", async () => {
    // No cached tokens, no CDP connection possible
    const provider = await resolveProvider({});
    expect(provider).toBeNull();
  });
});
