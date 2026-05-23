/**
 * Tests for the iframe-based token refresh path.
 *
 * Two flavors:
 *  - Unit tests that mock `chrome-remote-interface` to verify the
 *    connection / extraction logic (no real CDP needed).
 *  - One opt-in integration test that hits a live Superhuman.app
 *    running with --remote-debugging-port and asserts that
 *    refreshAllViaBackgroundPage actually returns tokens. Skipped
 *    unless SH_LIVE_CDP_PORT is set.
 */
import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";

const ORIGINAL_PORT = process.env.CDP_PORT;

afterEach(() => {
  if (ORIGINAL_PORT === undefined) delete process.env.CDP_PORT;
  else process.env.CDP_PORT = ORIGINAL_PORT;
  mock.restore();
});

// ---------------------------------------------------------------------------
// Unit tests with mocked CDP
// ---------------------------------------------------------------------------

describe("connectToBackgroundPage (mocked)", () => {
  beforeEach(() => {
    mock.restore();
  });

  test("returns null when no background_page target is present", async () => {
    mock.module("chrome-remote-interface", () => {
      const fn: any = async () => ({});
      fn.List = async () => [
        { type: "page", url: "https://mail.superhuman.com/eddyhu@gmail.com", id: "p1" },
        { type: "service_worker", url: "https://mail.superhuman.com/~backend/build/serviceworker.js", id: "sw1" },
      ];
      return { default: fn };
    });

    const { connectToBackgroundPage } = await import("../background-page-refresh");
    const conn = await connectToBackgroundPage(9999);
    expect(conn).toBeNull();
  });

  test("returns null when CDP.List throws", async () => {
    mock.module("chrome-remote-interface", () => {
      const fn: any = async () => ({});
      fn.List = async () => { throw new Error("connection refused"); };
      return { default: fn };
    });

    const { connectToBackgroundPage } = await import("../background-page-refresh");
    const conn = await connectToBackgroundPage(9999);
    expect(conn).toBeNull();
  });

  test("maps account iframes to execution contexts when bg page is reachable", async () => {
    const bgPageTarget = {
      type: "page",
      url: "https://mail.superhuman.com/~backend/build/background_page.html",
      id: "bg1",
    };

    const fakeClient: any = {
      Page: {
        enable: async () => {},
        getFrameTree: async () => ({
          frameTree: {
            frame: { id: "bg1", url: bgPageTarget.url, name: "" },
            childFrames: [
              {
                frame: { id: "frame-a", name: "eddyhu@gmail.com", url: "https://mail.superhuman.com/~backend/build/superhuman.html" },
              },
              {
                frame: { id: "frame-b", name: "ehu@law.virginia.edu", url: "https://mail.superhuman.com/~backend/build/superhuman.html" },
              },
              {
                frame: { id: "frame-c", name: "", url: "about:blank" },
              },
            ],
          },
        }),
      },
      Runtime: {
        enable: async () => {},
        disable: async () => {},
        evaluate: async () => ({ result: { value: null } }),
      },
      on: function (this: any, evt: string, handler: any) {
        if (evt === "Runtime.executionContextCreated") {
          // Replay two account contexts + one unrelated.
          setTimeout(() => {
            handler({ context: { id: 101, auxData: { frameId: "frame-a", isDefault: true } } });
            handler({ context: { id: 102, auxData: { frameId: "frame-b", isDefault: true } } });
            handler({ context: { id: 200, auxData: { frameId: "bg1", isDefault: true } } });
          }, 0);
        }
        return this;
      },
      off: function (this: any) { return this; },
      close: async () => {},
    };

    mock.module("chrome-remote-interface", () => {
      const fn: any = async () => fakeClient;
      fn.List = async () => [bgPageTarget];
      return { default: fn };
    });

    const { connectToBackgroundPage } = await import("../background-page-refresh");
    const conn = await connectToBackgroundPage(9999);
    expect(conn).not.toBeNull();
    expect(conn!.frameByEmail.get("eddyhu@gmail.com")).toBe("frame-a");
    expect(conn!.frameByEmail.get("ehu@law.virginia.edu")).toBe("frame-b");
    expect(conn!.contextByEmail.get("eddyhu@gmail.com")).toBe(101);
    expect(conn!.contextByEmail.get("ehu@law.virginia.edu")).toBe(102);
    expect(conn!.frameByEmail.has("")).toBe(false);
  });
});

describe("extractTokenFromIframe (mocked)", () => {
  beforeEach(() => mock.restore());

  test("returns null when the email isn't mapped to a context", async () => {
    mock.module("chrome-remote-interface", () => {
      const fn: any = async () => ({});
      fn.List = async () => [];
      return { default: fn };
    });
    const { extractTokenFromIframe } = await import("../background-page-refresh");
    const fakeConn = {
      client: { Runtime: { evaluate: async () => ({ result: { value: null } }) } } as any,
      contextByEmail: new Map<string, number>(),
      frameByEmail: new Map<string, string>(),
    };
    const t = await extractTokenFromIframe(fakeConn, "missing@example.com");
    expect(t).toBeNull();
  });

  test("returns null when iframe eval errors out", async () => {
    mock.module("chrome-remote-interface", () => {
      const fn: any = async () => ({});
      fn.List = async () => [];
      return { default: fn };
    });
    const { extractTokenFromIframe } = await import("../background-page-refresh");
    const fakeConn = {
      client: {
        Runtime: {
          evaluate: async () => ({ result: { value: { error: "no credential" } } }),
        },
      } as any,
      contextByEmail: new Map([["x@y.com", 1]]),
      frameByEmail: new Map(),
    };
    const t = await extractTokenFromIframe(fakeConn, "x@y.com");
    expect(t).toBeNull();
  });

  test("builds TokenInfo from a successful eval response with JWT exp", async () => {
    mock.module("chrome-remote-interface", () => {
      const fn: any = async () => ({});
      fn.List = async () => [];
      return { default: fn };
    });
    const { extractTokenFromIframe } = await import("../background-page-refresh");

    // Build a fake JWT with exp = 9_999_999_999 (year 2286).
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: 9_999_999_999, iss: "https://accounts.google.com" })).toString("base64url");
    const fakeJwt = `${header}.${payload}.sig`;

    const fakeConn = {
      client: {
        Runtime: {
          evaluate: async () => ({
            result: {
              value: {
                idToken: fakeJwt,
                accessToken: "ya29.opaque-google-token",
                email: "x@y.com",
                isMicrosoft: false,
                provider: "google",
                authDataExpires: 1_700_000_000_000,
                userId: "google-12345",
                userExternalId: "user_11SzDPi4sKPTbHQRMQ",
                userPrefix: "4sKP",
                deviceId: "dev-uuid",
              },
            },
          }),
        },
      } as any,
      contextByEmail: new Map([["x@y.com", 1]]),
      frameByEmail: new Map(),
    };

    const t = await extractTokenFromIframe(fakeConn, "x@y.com");
    expect(t).not.toBeNull();
    expect(t!.email).toBe("x@y.com");
    expect(t!.idToken).toBe(fakeJwt);
    expect(t!.accessToken).toBe("ya29.opaque-google-token");
    expect(t!.userPrefix).toBe("4sKP");
    expect(t!.userExternalId).toBe("user_11SzDPi4sKPTbHQRMQ");
    expect(t!.deviceId).toBe("dev-uuid");
    expect(t!.idTokenExpires).toBe(9_999_999_999 * 1000);
    expect(t!.superhumanToken?.token).toBe(fakeJwt);
    // For an opaque (non-JWT) Google access token, expiry falls back to
    // authData.expires.
    expect(t!.expires).toBe(1_700_000_000_000);
  });
});

// Live integration test lives in background-page-refresh.live.test.ts —
// kept in a separate file so module mocks from this file don't leak.
