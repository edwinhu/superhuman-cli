/**
 * Tests for Microsoft -> Outlook Web routing and the OutlookWebProvider shim.
 *
 * HERMETIC: SUPERHUMAN_CLI_CONFIG_DIR (read lazily by token-api AND owa-token)
 * is set only for the duration of these tests and RESTORED to its prior value
 * afterward, and the token-cache singleton is cleared after all tests. Setting
 * it at module scope leaks into every later-loaded test file — it flipped the
 * live attachment-e2e suite onto the wrong account. Do not do that.
 */

import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = mkdtempSync(join(tmpdir(), "owa-provider-test-"));

import { resolveProvider } from "../connection-provider";
import { OutlookWebProvider } from "../outlook-web-provider";
import { SuperhumanProvider } from "../superhuman-provider";
import {
  clearTokenCache,
  setTokenCacheForTest,
  type TokenInfo,
} from "../token-api";
import { clearOwaMemCacheForTest } from "../owa-token";

const HAD_CONFIG_DIR = Object.prototype.hasOwnProperty.call(
  process.env,
  "SUPERHUMAN_CLI_CONFIG_DIR"
);
const PRIOR_CONFIG_DIR = process.env.SUPERHUMAN_CLI_CONFIG_DIR;
const HAD_MS_BACKEND = Object.prototype.hasOwnProperty.call(
  process.env,
  "SUPERHUMAN_CLI_MS_BACKEND"
);
const PRIOR_MS_BACKEND = process.env.SUPERHUMAN_CLI_MS_BACKEND;

function restoreConfigDir() {
  if (HAD_CONFIG_DIR) process.env.SUPERHUMAN_CLI_CONFIG_DIR = PRIOR_CONFIG_DIR;
  else delete process.env.SUPERHUMAN_CLI_CONFIG_DIR;
}

function restoreMsBackend() {
  if (HAD_MS_BACKEND) process.env.SUPERHUMAN_CLI_MS_BACKEND = PRIOR_MS_BACKEND;
  else delete process.env.SUPERHUMAN_CLI_MS_BACKEND;
}

function seedOwaCache(map: Record<string, any>) {
  writeFileSync(join(TEST_DIR, "owa-tokens.json"), JSON.stringify(map));
}

function clearOwaCache() {
  try {
    rmSync(join(TEST_DIR, "owa-tokens.json"));
  } catch {}
}

beforeEach(() => {
  process.env.SUPERHUMAN_CLI_CONFIG_DIR = TEST_DIR;
  delete process.env.SUPERHUMAN_CLI_MS_BACKEND; // default to "auto" unless a test sets it
  clearTokenCache();
  clearOwaMemCacheForTest();
  clearOwaCache();
});

afterEach(() => {
  clearTokenCache();
  clearOwaMemCacheForTest();
  clearOwaCache();
  restoreConfigDir();
  restoreMsBackend();
});

afterAll(() => {
  // Leave the shared singletons + env exactly as later test files expect them.
  clearTokenCache();
  clearOwaMemCacheForTest();
  restoreConfigDir();
  restoreMsBackend();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

describe("providerFromToken: Microsoft primary=Superhuman, fallback=OWA", () => {
  const msToken = (sh?: { token: string; expires: number }): TokenInfo => ({
    accessToken: "oauth",
    email: "ehu@law.virginia.edu",
    expires: Date.now() + 3600_000,
    isMicrosoft: true,
    ...(sh ? { superhumanToken: sh } : {}),
  });

  test("microsoft with NO superhuman token falls back to OutlookWebProvider", async () => {
    setTokenCacheForTest("ehu@law.virginia.edu", msToken());
    const provider = await resolveProvider({ account: "ehu@law.virginia.edu" });
    expect(provider).toBeInstanceOf(OutlookWebProvider);
  });

  test("microsoft with an EXPIRED superhuman token (revoked tenant) falls back to OWA", async () => {
    setTokenCacheForTest(
      "ehu@law.virginia.edu",
      msToken({ token: "revoked-jwt", expires: Date.now() - 1000 })
    );
    const provider = await resolveProvider({ account: "ehu@law.virginia.edu" });
    expect(provider).toBeInstanceOf(OutlookWebProvider);
  });

  test("microsoft with a VALID superhuman token uses Superhuman (primary)", async () => {
    setTokenCacheForTest(
      "ehu@law.virginia.edu",
      msToken({ token: "good-jwt", expires: Date.now() + 3600_000 })
    );
    const provider = await resolveProvider({ account: "ehu@law.virginia.edu" });
    expect(provider).toBeInstanceOf(SuperhumanProvider);
  });

  test("SUPERHUMAN_CLI_MS_BACKEND=outlook-web forces OWA even with a valid SH token", async () => {
    process.env.SUPERHUMAN_CLI_MS_BACKEND = "outlook-web";
    setTokenCacheForTest(
      "ehu@law.virginia.edu",
      msToken({ token: "good-jwt", expires: Date.now() + 3600_000 })
    );
    const provider = await resolveProvider({ account: "ehu@law.virginia.edu" });
    expect(provider).toBeInstanceOf(OutlookWebProvider);
  });

  test("SUPERHUMAN_CLI_MS_BACKEND=superhuman forces Superhuman even with an expired token", async () => {
    process.env.SUPERHUMAN_CLI_MS_BACKEND = "superhuman";
    setTokenCacheForTest(
      "ehu@law.virginia.edu",
      msToken({ token: "jwt", expires: Date.now() - 1000 })
    );
    const provider = await resolveProvider({ account: "ehu@law.virginia.edu" });
    expect(provider).toBeInstanceOf(SuperhumanProvider);
  });

  test("a google token still routes to SuperhumanProvider (no regression)", async () => {
    const token: TokenInfo = {
      accessToken: "g-oauth",
      email: "user@gmail.com",
      expires: Date.now() + 3600_000,
      isMicrosoft: false,
      superhumanToken: { token: "sh-jwt", expires: Date.now() + 3600_000 },
    };
    setTokenCacheForTest(token.email, token);

    const provider = await resolveProvider({ account: "user@gmail.com" });
    expect(provider).toBeInstanceOf(SuperhumanProvider);
  });
});

describe("resolveProvider: OWA broker fallback", () => {
  test("surfaces a microsoft mailbox known only to the OWA broker", async () => {
    // Not in the token cache; only the OWA broker knows it.
    seedOwaCache({
      "ehu@law.virginia.edu": {
        accessToken: "owa-tok",
        email: "ehu@law.virginia.edu",
        expiresOn: Date.now() + 3600_000,
      },
    });
    const provider = await resolveProvider({ account: "ehu@law.virginia.edu" });
    expect(provider).toBeInstanceOf(OutlookWebProvider);
  });

  test("unknown account with no broker entry is null", async () => {
    const provider = await resolveProvider({ account: "nobody@nowhere.com" });
    expect(provider).toBeNull();
  });
});

describe("OutlookWebProvider.getToken shim", () => {
  test("returns a TokenInfo with the OWA access token and isOutlookWeb", async () => {
    seedOwaCache({
      "ehu@law.virginia.edu": {
        accessToken: "owa-access-token",
        email: "ehu@law.virginia.edu",
        expiresOn: Date.now() + 3600_000,
      },
    });
    const provider = new OutlookWebProvider("ehu@law.virginia.edu");
    const token = await provider.getToken();
    expect(token.accessToken).toBe("owa-access-token");
    expect(token.email).toBe("ehu@law.virginia.edu");
    expect(token.isMicrosoft).toBe(true);
    expect(token.isOutlookWeb).toBe(true);
  });

  test("getAccountInfo reports the microsoft provider", async () => {
    const provider = new OutlookWebProvider("ehu@law.virginia.edu");
    const info = await provider.getAccountInfo();
    expect(info).toEqual({
      email: "ehu@law.virginia.edu",
      isMicrosoft: true,
      provider: "microsoft",
    });
  });
});
