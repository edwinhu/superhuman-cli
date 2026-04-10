import { test, expect, describe, afterEach, beforeEach, mock } from "bun:test";
import { getCDPHost, getCDPPort } from "../superhuman-api";
import {
  getCachedToken,
  getCachedTokenRaw,
  setTokenCacheForTest,
  clearTokenCache,
  type TokenInfo,
} from "../token-api";

const originalHost = process.env.CDP_HOST;
const originalPort = process.env.CDP_PORT;

afterEach(() => {
  if (originalHost === undefined) delete process.env.CDP_HOST;
  else process.env.CDP_HOST = originalHost;
  if (originalPort === undefined) delete process.env.CDP_PORT;
  else process.env.CDP_PORT = originalPort;
});

describe("getCDPHost", () => {
  test("returns localhost by default", () => {
    delete process.env.CDP_HOST;
    delete process.env.HOST_IP;
    expect(getCDPHost()).toBe("localhost");
  });

  test("returns CDP_HOST when set", () => {
    process.env.CDP_HOST = "host.docker.internal";
    expect(getCDPHost()).toBe("host.docker.internal");
  });

  test("returns HOST_IP as fallback", () => {
    delete process.env.CDP_HOST;
    process.env.HOST_IP = "192.168.1.100";
    expect(getCDPHost()).toBe("192.168.1.100");
    delete process.env.HOST_IP;
  });
});

describe("getCDPPort", () => {
  test("returns 9250 by default", () => {
    delete process.env.CDP_PORT;
    expect(getCDPPort()).toBe(9250);
  });

  test("returns custom port when set", () => {
    process.env.CDP_PORT = "9400";
    expect(getCDPPort()).toBe(9400);
  });
});

// ---------------------------------------------------------------------------
// Container scenario: expired token + unreachable CDP
// ---------------------------------------------------------------------------

describe("container scenarios (expired tokens, unreachable CDP)", () => {
  beforeEach(() => {
    clearTokenCache();
  });

  test("getCachedToken returns undefined when cache is empty", async () => {
    // No token in cache, no CDP to refresh from
    const result = await getCachedToken("nobody@example.com");
    expect(result).toBeUndefined();
  });

  test("getCachedToken with expired token attempts refresh (returns stale token when CDP unreachable)", async () => {
    // Simulate container: token is expired, CDP is not reachable
    // refreshTokenViaCDP will call connectToSuperhuman which will fail
    // because no Chrome is running — getCachedToken should fall back to
    // returning the stale token so the caller can attempt the backend API.
    // The Superhuman backend handles 401 with its own retry logic, and
    // returning undefined here caused a misleading "No cached tokens" error.
    const expiredToken: TokenInfo = {
      accessToken: "expired-access",
      email: "container@example.com",
      expires: Date.now() - 3600000, // expired 1 hour ago
      isMicrosoft: false,
      idToken: "expired-id",
    };
    setTokenCacheForTest("container@example.com", expiredToken);

    // getCachedToken sees the expired token and tries refreshTokenViaCDP
    // which tries connectToSuperhuman → fails (no Chrome) → falls back to stale token
    // Set CDP to a port nothing is listening on to ensure it fails fast
    const origPort = process.env.CDP_PORT;
    process.env.CDP_PORT = "19999";
    try {
      const result = await getCachedToken("container@example.com");
      // Should return the stale token (not undefined) so backend API can be attempted
      expect(result).toBeDefined();
      expect(result!.email).toBe("container@example.com");
      expect(result!.accessToken).toBe("expired-access");
    } finally {
      if (origPort === undefined) delete process.env.CDP_PORT;
      else process.env.CDP_PORT = origPort;
    }
  });

  test("getCachedTokenRaw returns expired token without attempting refresh", () => {
    const expiredToken: TokenInfo = {
      accessToken: "expired-access",
      email: "container@example.com",
      expires: Date.now() - 3600000,
      isMicrosoft: true,
    };
    setTokenCacheForTest("container@example.com", expiredToken);

    // getCachedTokenRaw should return the token as-is, no refresh
    const result = getCachedTokenRaw("container@example.com");
    expect(result).toBeDefined();
    expect(result!.email).toBe("container@example.com");
    expect(result!.isMicrosoft).toBe(true);
    expect(result!.expires).toBeLessThan(Date.now()); // still expired
  });

  test("getCachedToken returns valid token without CDP call", async () => {
    // Valid token should be returned directly, no CDP needed
    const validToken: TokenInfo = {
      accessToken: "valid-access",
      email: "valid@example.com",
      expires: Date.now() + 3600000, // 1 hour from now
      isMicrosoft: false,
      idToken: "valid-id",
    };
    setTokenCacheForTest("valid@example.com", validToken);

    const result = await getCachedToken("valid@example.com");
    expect(result).toBeDefined();
    expect(result!.email).toBe("valid@example.com");
    expect(result!.accessToken).toBe("valid-access");
  });
});
