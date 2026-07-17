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

describe("real Electron/web shapes must keep classifying (false negative is worse)", () => {
  test("superhuman-app://superhuman.com/background_page.html -> electron", () => {
    expect(
      classifyTarget(page("superhuman-app://superhuman.com/background_page.html"))
    ).toBe("electron");
  });

  test("https://mail.superhuman.com/~backend/build/background_page.html -> electron", () => {
    expect(
      classifyTarget(page("https://mail.superhuman.com/~backend/build/background_page.html"))
    ).toBe("electron");
  });

  test("https://mail.superhuman.com/e@x.com/inbox -> chrome", () => {
    expect(classifyTarget(page("https://mail.superhuman.com/e@x.com/inbox"))).toBe("chrome");
  });
});
