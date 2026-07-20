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
import { test, expect, describe, mock, afterEach, afterAll } from "bun:test";
import RealCDPDefault from "chrome-remote-interface";

// Snapshot the REAL chrome-remote-interface export before any mock.module runs.
// bun's mock.restore() does NOT revert mock.module — it mutates the module's
// global bindings (see read-backend.test.ts / labels-list.test.ts) — so a
// module mock left here leaks into later test files: attachment-e2e's
// CDP({ port }) would resolve to the stub `{}` instead of throwing, so that
// E2E suite stops skipping (its Superhuman port is down) and runs against a
// mailbox that now routes to Outlook Web. Restore the real module when this
// file's tests finish so downstream files see the unmocked import.
const REAL_CRI = { default: RealCDPDefault };

afterEach(() => {
  mock.restore();
});

afterAll(() => {
  mock.module("chrome-remote-interface", () => REAL_CRI);
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

/**
 * The MEASURED target set of the shipping Superhuman.app.
 *
 * Captured live 2026-07-17 from /Applications/Superhuman.app relaunched with
 * --remote-debugging-port=9252. These are every `type: "page"` target it
 * exposed, verbatim. Do not "tidy" these URLs — they are a recording, not a
 * design. The background page is served over HTTPS on mail.superhuman.com;
 * the superhuman-app:// targets that DO exist are the main window and the tab
 * strip, on hostname "production", and are NOT the background page.
 *
 * The previous fixture here asserted a background page at
 * superhuman-app://superhuman.com/background_page.html. No such target exists,
 * and none ever did (see cdp-endpoint.ts's superhuman-app:// branch comment).
 */
const REAL_APP_TARGETS = [
  { type: "page", url: "superhuman-app://production/browserWindow.html", id: "win1" },
  {
    type: "page",
    url: "https://mail.superhuman.com/eddyhu@gmail.com/inbox/other/thread/abc123",
    id: "mail1",
  },
  { type: "page", url: "superhuman-app://production/tabs.html", id: "tabs1" },
  {
    type: "page",
    url: "https://mail.superhuman.com/~backend/build/background_page.html",
    id: "bg1",
  },
];

describe("isBackgroundPageReachable", () => {
  test("true against the real app's measured target set", async () => {
    mockCDPList(REAL_APP_TARGETS);
    const { isBackgroundPageReachable } = await import("../app-health");
    expect(await isBackgroundPageReachable(9999)).toBe(true);
  });

  test("the real background page ALONE is sufficient (it is the target that carries this)", async () => {
    // Pinning which target actually satisfies the gate. If someone breaks the
    // https/mail.superhuman.com branch, this fails — the test above would not,
    // because it would still have three other targets to hide behind.
    mockCDPList([REAL_APP_TARGETS[3]]);
    const { isBackgroundPageReachable } = await import("../app-health");
    expect(await isBackgroundPageReachable(9999)).toBe(true);
  });

  test("false when only the app's non-background-page targets are present", async () => {
    // superhuman-app://production/{browserWindow,tabs}.html are the real app,
    // but they are NOT the background page — silent refresh cannot run on them,
    // so the gate must stay shut rather than promise a path that does not work.
    mockCDPList([REAL_APP_TARGETS[0], REAL_APP_TARGETS[2]]);
    const { isBackgroundPageReachable } = await import("../app-health");
    expect(await isBackgroundPageReachable(9999)).toBe(false);
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
