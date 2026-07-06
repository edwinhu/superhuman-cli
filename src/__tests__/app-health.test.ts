/**
 * Tests for the CDP health-check module.
 *
 * `isBackgroundPageReachable` is the precondition gate for silent token
 * refresh: it must be true ONLY when a Superhuman background_page target
 * is actually present on the port — not merely when the port answers
 * (an unrelated Chromium — Dia, Obsidian — can respond on a candidate
 * port without exposing the Superhuman background page). Getting this
 * wrong is exactly what caused the recurring focus-steal: a false
 * "reachable" would let the caller assume the silent path works.
 */
import { test, expect, describe, mock, afterEach } from "bun:test";

afterEach(() => {
  mock.restore();
});

function mockCDPList(targets: any[] | (() => never)) {
  mock.module("chrome-remote-interface", () => {
    const fn: any = async () => ({});
    fn.List = async () => {
      if (typeof targets === "function") return targets();
      return targets;
    };
    return { default: fn };
  });
}

describe("isBackgroundPageReachable", () => {
  test("true when a Superhuman background_page target is present", async () => {
    mockCDPList([
      { type: "page", url: "https://mail.superhuman.com/eddyhu@gmail.com", id: "p1" },
      {
        type: "page",
        url: "superhuman-app://superhuman.com/background_page.html",
        id: "bg1",
      },
    ]);
    const { isBackgroundPageReachable } = await import("../app-health");
    expect(await isBackgroundPageReachable(9999)).toBe(true);
  });

  test("false when only a non-Superhuman Chromium answers (Dia/Obsidian)", async () => {
    // Port is open and returns targets, but none is a Superhuman bg page.
    mockCDPList([
      { type: "page", url: "chrome://start-page/ABC", id: "p1" },
      {
        type: "background_page",
        url: "chrome-extension://xyz/offscreen.html",
        id: "ext1",
      },
      { type: "page", url: "app://obsidian.md/index.html", id: "obs1" },
    ]);
    const { isBackgroundPageReachable } = await import("../app-health");
    expect(await isBackgroundPageReachable(9999)).toBe(false);
  });

  test("false when the port refuses the connection (CDP.List throws)", async () => {
    mockCDPList(() => {
      throw new Error("ECONNREFUSED");
    });
    const { isBackgroundPageReachable } = await import("../app-health");
    expect(await isBackgroundPageReachable(9999)).toBe(false);
  });

  test("false when a background_page.html exists but is not Superhuman", async () => {
    mockCDPList([
      {
        type: "page",
        url: "https://example.com/background_page.html",
        id: "x1",
      },
    ]);
    const { isBackgroundPageReachable } = await import("../app-health");
    expect(await isBackgroundPageReachable(9999)).toBe(false);
  });
});
