/**
 * Tests for read-status.ts — markAsRead / markAsUnread with portal + backend fallback.
 */

import { test, expect, describe, mock } from "bun:test";
import { SuperhumanProvider } from "../superhuman-provider";
import type { SuperhumanTokenInfo } from "../superhuman-provider";
import { markAsRead, markAsUnread } from "../read-status";

const sampleToken: SuperhumanTokenInfo = {
  token: "test-jwt",
  email: "test@example.com",
  expires: Date.now() + 3600_000,
};

function createProvider(opts: {
  hasPortal?: boolean;
  portalThrows?: boolean;
  backendResponse?: any;
  backendThrows?: boolean;
}) {
  const provider = new SuperhumanProvider(sampleToken);

  if (opts.hasPortal) {
    (provider as any).conn = {}; // hasPortal() returns true
    provider.portalInvoke = mock(() => {
      if (opts.portalThrows) throw new Error("Undefined method modifyLabels");
      return Promise.resolve({});
    }) as any;
  }

  if (opts.backendThrows) {
    provider.backendFetch = mock(() =>
      Promise.reject(new Error("Backend error"))
    ) as any;
  } else {
    provider.backendFetch = mock(() =>
      Promise.resolve(opts.backendResponse ?? {})
    ) as any;
  }

  return provider;
}

describe("markAsRead", () => {
  test("uses portal when available and it succeeds", async () => {
    const provider = createProvider({ hasPortal: true, portalThrows: false });

    const result = await markAsRead(provider, "thread_123");

    expect(result.success).toBe(true);
    expect(provider.portalInvoke).toHaveBeenCalledTimes(1);
    // backendFetch should NOT have been called
    expect(provider.backendFetch).not.toHaveBeenCalled();
  });

  test("falls back to backend when portal fails", async () => {
    const provider = createProvider({ hasPortal: true, portalThrows: true });

    const result = await markAsRead(provider, "thread_123");

    expect(result.success).toBe(true);
    expect(provider.portalInvoke).toHaveBeenCalledTimes(1);
    expect(provider.backendFetch).toHaveBeenCalledTimes(1);

    // Verify backend call payload
    const [path, options] = (provider.backendFetch as any).mock.calls[0];
    expect(path).toBe("/v3/userdata.writeMessage");
    const body = JSON.parse(options.body);
    expect(body.writes).toBeDefined();
    expect(body.writes[0].path).toContain("thread_123");
  });

  test("uses backend directly when no portal available", async () => {
    const provider = createProvider({ hasPortal: false });

    const result = await markAsRead(provider, "thread_456");

    expect(result.success).toBe(true);
    expect(provider.backendFetch).toHaveBeenCalledTimes(1);
  });

  test("returns error when both portal and backend fail", async () => {
    const provider = createProvider({
      hasPortal: true,
      portalThrows: true,
      backendThrows: true,
    });

    const result = await markAsRead(provider, "thread_789");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("markAsUnread", () => {
  test("falls back to backend when portal fails", async () => {
    const provider = createProvider({ hasPortal: true, portalThrows: true });

    const result = await markAsUnread(provider, "thread_123");

    expect(result.success).toBe(true);
    expect(provider.portalInvoke).toHaveBeenCalledTimes(1);
    expect(provider.backendFetch).toHaveBeenCalledTimes(1);

    // Verify backend call adds UNREAD
    const [path, options] = (provider.backendFetch as any).mock.calls[0];
    expect(path).toBe("/v3/userdata.writeMessage");
    const body = JSON.parse(options.body);
    expect(body.writes[0].path).toContain("thread_123");
  });

  test("uses portal when available and it succeeds", async () => {
    const provider = createProvider({ hasPortal: true, portalThrows: false });

    const result = await markAsUnread(provider, "thread_123");

    expect(result.success).toBe(true);
    expect(provider.portalInvoke).toHaveBeenCalledTimes(1);
    expect(provider.backendFetch).not.toHaveBeenCalled();
  });

  test("uses backend directly when no portal available", async () => {
    const provider = createProvider({ hasPortal: false });

    const result = await markAsUnread(provider, "thread_456");

    expect(result.success).toBe(true);
    expect(provider.backendFetch).toHaveBeenCalledTimes(1);
  });
});
