import { describe, test, expect } from "bun:test";
import {
  cookieDomainMatches,
  cookiePathMatches,
  readSessionCookieHeader,
  refreshViaSessionCookies,
  toCookieHeader,
} from "../session-refresh";

describe("cookieDomainMatches", () => {
  test("dot-prefixed cookies cover the domain and subdomains", () => {
    expect(cookieDomainMatches(".superhuman.com", "accounts.superhuman.com")).toBe(true);
    expect(cookieDomainMatches(".superhuman.com", "superhuman.com")).toBe(true);
  });

  test("host-only cookies must match exactly", () => {
    expect(cookieDomainMatches("accounts.superhuman.com", "accounts.superhuman.com")).toBe(true);
    // media.* carries its own device-id; it must not reach accounts/mail.
    expect(cookieDomainMatches("media.superhuman.com", "accounts.superhuman.com")).toBe(false);
  });

  test("matches labels, not substrings", () => {
    expect(cookieDomainMatches(".notsuperhuman.com", "accounts.superhuman.com")).toBe(false);
    expect(cookieDomainMatches("superhuman.com.evil.test", "superhuman.com")).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(cookieDomainMatches(".SuperHuman.COM", "Accounts.Superhuman.com")).toBe(true);
  });
});

describe("cookiePathMatches", () => {
  test('cookie-path "/" matches any request path', () => {
    expect(cookiePathMatches("/", "/~backend/v3/")).toBe(true);
    expect(cookiePathMatches("/", "/")).toBe(true);
  });

  test("a deeper cookie-path does not match a shallower request", () => {
    // The bug this guards: Storage.getCookies has no `urls` filter, so a
    // /legacy-scoped duplicate would otherwise ride along.
    expect(cookiePathMatches("/legacy", "/~backend/v3/")).toBe(false);
  });

  test("prefix matches only at a boundary", () => {
    expect(cookiePathMatches("/~backend", "/~backend/v3/")).toBe(true);
    expect(cookiePathMatches("/~back", "/~backend/v3/")).toBe(false);
  });

  test("empty path is treated as /", () => {
    expect(cookiePathMatches("", "/~backend/v3/")).toBe(true);
  });
});

describe("toCookieHeader", () => {
  const c = (name: string, domain: string, path = "/") => ({
    name,
    value: `v_${name}`,
    domain,
    path,
  });

  test("keeps cookies in scope for the backend path", () => {
    expect(toCookieHeader([c("csrf", ".superhuman.com")])).toBe("csrf=v_csrf");
  });

  test("drops other subdomains' same-named cookies", () => {
    const header = toCookieHeader([
      c("device-id", "accounts.superhuman.com"),
      c("device-id", "media.superhuman.com"),
    ]);
    // Exactly one device-id — not a duplicate with media's value.
    expect(header).toBe("device-id=v_device-id");
  });

  test("drops path-scoped duplicates the browser would not send", () => {
    const header = toCookieHeader([
      c("csrf", ".superhuman.com", "/"),
      { name: "csrf", value: "stale", domain: ".superhuman.com", path: "/legacy" },
    ]);
    expect(header).toBe("csrf=v_csrf");
  });

  test("orders longer paths first, per RFC 6265 §5.4", () => {
    // Storage.getCookies' array order is unspecified. A backend taking the
    // FIRST occurrence of a duplicated name must see the more specific cookie,
    // exactly as a browser would send it.
    const header = toCookieHeader([
      { name: "session", value: "root", domain: "accounts.superhuman.com", path: "/" },
      { name: "session", value: "backend", domain: "accounts.superhuman.com", path: "/~backend" },
    ]);
    expect(header).toBe("session=backend; session=root");
  });

  test("null when nothing applies or the list is empty", () => {
    expect(toCookieHeader([c("x", "example.com")])).toBeNull();
    expect(toCookieHeader([])).toBeNull();
    expect(toCookieHeader(undefined)).toBeNull();
  });
});

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
