import { test, expect } from "bun:test";
import {
  readSessionCookieHeader,
  refreshViaSessionCookies,
} from "../session-refresh";

// An unused port: nothing is listening, so CDP discovery must fail cleanly.
const DEAD_PORT = 9;

test("readSessionCookieHeader returns null when no browser is reachable", async () => {
  expect(await readSessionCookieHeader(DEAD_PORT)).toBeNull();
});

test("refreshViaSessionCookies returns null (never throws) with no browser", async () => {
  // Callers treat null as "couldn't refresh, keep the stale token" — a throw
  // here would break every read path that opportunistically refreshes.
  expect(await refreshViaSessionCookies("nobody@example.com", undefined, DEAD_PORT))
    .toBeNull();
});

test("readSessionCookieHeader prefers the browser target over page targets", async () => {
  // Page targets route through a renderer, and a busy renderer never answers —
  // measured live, one of six page targets hung indefinitely on
  // Network.getCookies while five answered in milliseconds, and which one hangs
  // drifts over time. So the browser target must be tried FIRST; page targets
  // exist only as a fallback for deployments that may not serve Storage there.
  const CDP = (await import("chrome-remote-interface")).default as any;
  const realVersion = CDP.Version;
  const realList = CDP.List;
  const order: string[] = [];
  CDP.Version = async (...args: unknown[]) => {
    order.push("browser");
    return realVersion(...args);
  };
  CDP.List = async (...args: unknown[]) => {
    order.push("pages");
    return realList(...args);
  };
  try {
    await readSessionCookieHeader(DEAD_PORT);
    // Both may be attempted against a dead port; what matters is the order.
    expect(order[0]).toBe("browser");
  } finally {
    CDP.Version = realVersion;
    CDP.List = realList;
  }
});

test("refreshViaSessionCookies short-circuits before any network call", async () => {
  // Without cookies it must not reach accounts.superhuman.com at all.
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    called = true;
    return realFetch(...args);
  }) as typeof fetch;
  try {
    await refreshViaSessionCookies("nobody@example.com", undefined, DEAD_PORT);
    expect(called).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
