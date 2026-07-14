import { test, expect, describe, mock } from "bun:test";
import { SuperhumanProvider } from "../superhuman-provider";
import type { SuperhumanTokenInfo } from "../superhuman-provider";
import type { SuperhumanConnection } from "../superhuman-api";

describe("SuperhumanProvider", () => {
  const sampleToken: SuperhumanTokenInfo = {
    token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test-jwt-token",
    email: "user@example.com",
    accountId: "acct_123",
    expires: Date.now() + 3600_000,
  };

  test("can be created with email + JWT token", () => {
    const provider = new SuperhumanProvider(sampleToken);
    expect(provider).toBeInstanceOf(SuperhumanProvider);
  });

  test("getToken() returns a TokenInfo-compatible object with the JWT", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    const token = await provider.getToken();

    // Must have accessToken set to the JWT for backward compat
    expect(token.accessToken).toBe(sampleToken.token);
    expect(token.email).toBe(sampleToken.email);
    expect(token.isMicrosoft).toBe(false);
    expect(token.expires).toBe(sampleToken.expires!);
    // superhumanToken nested field should also be set
    expect(token.superhumanToken).toEqual({
      token: sampleToken.token,
      expires: sampleToken.expires!,
    });
  });

  test("getToken() with email param returns token if email matches", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    const token = await provider.getToken("user@example.com");
    expect(token.email).toBe("user@example.com");
  });

  test("getToken() with wrong email throws", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    expect(provider.getToken("other@example.com")).rejects.toThrow(
      /does not match/
    );
  });

  test("getCurrentEmail() returns the configured email", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    const email = await provider.getCurrentEmail();
    expect(email).toBe("user@example.com");
  });

  test("getAccountInfo() returns provider: superhuman", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    const info = await provider.getAccountInfo();
    expect(info as unknown as Record<string, unknown>).toEqual({
      email: "user@example.com",
      isMicrosoft: false,
      provider: "superhuman",
    });
  });

  test("hasPortal() returns false when no CDP connection", () => {
    const provider = new SuperhumanProvider(sampleToken);
    expect(provider.hasPortal()).toBe(false);
  });

  test("hasPortal() returns true when CDP connection is provided", () => {
    // Minimal mock of SuperhumanConnection
    const mockConn = {
      client: {},
      Runtime: {},
      Input: {},
      Network: {},
      Page: {},
    } as unknown as SuperhumanConnection;

    const provider = new SuperhumanProvider(sampleToken, mockConn);
    expect(provider.hasPortal()).toBe(true);
  });

  test("portalInvoke() throws when no CDP connection", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    expect(
      provider.portalInvoke("threadInternal", "listAsync", [])
    ).rejects.toThrow(/no CDP connection/i);
  });

  test("disconnect() is a no-op without CDP connection", async () => {
    const provider = new SuperhumanProvider(sampleToken);
    // Should not throw
    await provider.disconnect();
  });

  test("backendFetch() makes authenticated request", async () => {
    const provider = new SuperhumanProvider(sampleToken);

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    globalThis.fetch = mockFetch as any;

    try {
      const result = await provider.backendFetch("/v3/userdata.getThreads", {
        method: "POST",
        body: JSON.stringify({ filter: {} }),
      });

      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(
        "https://mail.superhuman.com/~backend/v3/userdata.getThreads"
      );
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
        `Bearer ${sampleToken.token}`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
