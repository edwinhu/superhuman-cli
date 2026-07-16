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

test("readSessionCookieHeader never attaches to a page target", async () => {
  // The point of the browser-level read: a page target routes through a
  // renderer, and a busy renderer never answers — measured live, one of six
  // page targets hung indefinitely on Network.getCookies while five answered
  // in milliseconds, and which one hangs drifts over time. Attaching to any
  // page at all reintroduces that gamble, so assert we never enumerate them.
  const CDP = (await import("chrome-remote-interface")).default as any;
  const realList = CDP.List;
  let listed = false;
  CDP.List = async (...args: unknown[]) => {
    listed = true;
    return realList(...args);
  };
  try {
    await readSessionCookieHeader(DEAD_PORT);
    expect(listed).toBe(false);
  } finally {
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
