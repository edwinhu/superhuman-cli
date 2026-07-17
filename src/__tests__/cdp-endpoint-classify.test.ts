import { test, expect, describe } from "bun:test";
import { classifyTarget, rankTargets } from "../cdp-endpoint";

function page(url: string) {
  return { type: "page", url };
}

describe("isElectronTarget apex-fallback regression", () => {
  test("accounts.superhuman.com/background_page.html is NOT electron", () => {
    expect(
      classifyTarget(page("https://accounts.superhuman.com/background_page.html"))
    ).not.toBe("electron");
  });

  test("accounts.superhuman.com/background_page.html classifies as null (not chrome either)", () => {
    // It is not the web app's inbox host, so it must not win any role.
    expect(
      classifyTarget(page("https://accounts.superhuman.com/background_page.html"))
    ).toBeNull();
  });

  test("an impostor background_page.html on a non-superhuman subdomain does not outrank the real mail tab in rankTargets", () => {
    const targets = [
      page("https://accounts.superhuman.com/background_page.html"),
      page("https://mail.superhuman.com/e@x.com/inbox"),
    ];
    const ranked = rankTargets(targets);
    // The real mail tab must be present and must not be beaten by the impostor
    // classifying as "electron" (which ranks first).
    expect(ranked.some((r) => r.source === "chrome" && r.target === targets[1])).toBe(true);
    expect(ranked.some((r) => r.source === "electron" && r.target === targets[0])).toBe(false);
  });
});

/**
 * MEASURED, not assumed.
 *
 * Captured live 2026-07-17 from the shipping /Applications/Superhuman.app
 * relaunched with --remote-debugging-port=9252. Every `type: "page"` target it
 * exposed, with the classification each must receive. This table is a
 * recording; if the app changes, re-measure and update it — do not adjust the
 * classifier to make a guess here go green.
 */
describe("the real app's measured targets must classify correctly (false negative is worse)", () => {
  test("superhuman-app://production/browserWindow.html -> null (main window, not the bg page)", () => {
    expect(classifyTarget(page("superhuman-app://production/browserWindow.html"))).toBeNull();
  });

  test("superhuman-app://production/tabs.html -> null (tab strip, not the bg page)", () => {
    expect(classifyTarget(page("superhuman-app://production/tabs.html"))).toBeNull();
  });

  test("https://mail.superhuman.com/~backend/build/background_page.html -> electron (THE real background page)", () => {
    expect(
      classifyTarget(page("https://mail.superhuman.com/~backend/build/background_page.html"))
    ).toBe("electron");
  });

  test("https://mail.superhuman.com/e@x.com/inbox -> chrome", () => {
    expect(classifyTarget(page("https://mail.superhuman.com/e@x.com/inbox"))).toBe("chrome");
  });

  test("the real background page outranks the app's other targets (electron ranks first)", () => {
    const targets = [
      page("superhuman-app://production/browserWindow.html"),
      page("https://mail.superhuman.com/e@x.com/inbox/other/thread/abc123"),
      page("superhuman-app://production/tabs.html"),
      page("https://mail.superhuman.com/~backend/build/background_page.html"),
    ];
    const ranked = rankTargets(targets);
    // Exactly two viable targets, bg page first; the window/tabs are not viable.
    expect(ranked.map((r) => r.source)).toEqual(["electron", "chrome"]);
    expect(ranked[0]!.target).toBe(targets[3]!);
  });
});

/**
 * The superhuman-app:// branch's own behaviour.
 *
 * The scheme is REAL (browserWindow.html / tabs.html above prove it), but no
 * superhuman-app:// BACKGROUND PAGE has ever been observed. The branch is kept
 * as defensive cover for a build that might serve one; these tests pin that it
 * cannot be widened into an impostor hole while it sits there unused.
 */
describe("superhuman-app:// branch is narrow (unobserved shape, must stay hostile to impostors)", () => {
  test("superhuman-app://evil.example/background_page.html -> null", () => {
    expect(classifyTarget(page("superhuman-app://evil.example/background_page.html"))).toBeNull();
  });

  test("superhuman-app://superhuman.com/evil.html -> null (path must be the bg page)", () => {
    expect(classifyTarget(page("superhuman-app://superhuman.com/evil.html"))).toBeNull();
  });

  test("superhuman-app://production/background_page.html -> null (NOT measured; not trusted)", () => {
    // Deliberate: "production" is the real hostname for the window/tabs, so it
    // is the tempting host to widen to. No background page has been observed on
    // it, and guessing here would trust a shape nobody has seen. If a real app
    // build ever serves this, MEASURE it, then change this test and the branch
    // together.
    expect(classifyTarget(page("superhuman-app://production/background_page.html"))).toBeNull();
  });
});
