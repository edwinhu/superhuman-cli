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
