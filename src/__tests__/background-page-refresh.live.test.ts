/**
 * Live integration test for the iframe-based token refresh.
 *
 * Skipped unless SH_LIVE_CDP_PORT is set. Run with:
 *
 *   SH_LIVE_CDP_PORT=9252 bun test src/__tests__/background-page-refresh.live.test.ts
 *
 * Hits a real Superhuman.app running with --remote-debugging-port and
 * asserts that every linked account refreshes via the iframe path —
 * proving the focus-stealing fix works against the actual app.
 *
 * Kept in a separate file from the unit tests so module mocks from those
 * tests can't leak into this one.
 */
import { test, expect, describe, afterEach } from "bun:test";

const ORIGINAL_PORT = process.env.CDP_PORT;
afterEach(() => {
  if (ORIGINAL_PORT === undefined) delete process.env.CDP_PORT;
  else process.env.CDP_PORT = ORIGINAL_PORT;
});

const livePort = process.env.SH_LIVE_CDP_PORT;
const maybeIt = livePort ? test : test.skip;

describe("refreshAllViaBackgroundPage (live)", () => {
  maybeIt("refreshes all loaded accounts via iframe path", async () => {
    process.env.CDP_PORT = livePort;
    const { refreshAllViaBackgroundPage } = await import("../background-page-refresh");
    const tokens = await refreshAllViaBackgroundPage();
    expect(tokens).not.toBeNull();
    expect(tokens!.length).toBeGreaterThan(0);
    for (const t of tokens!) {
      expect(t.idToken).toBeTruthy();
      expect(t.accessToken).toBeTruthy();
      expect(t.email).toMatch(/@/);
      expect(t.userPrefix).toBeTruthy();
      expect(t.idTokenExpires!).toBeGreaterThan(Date.now());
    }
  });
});
