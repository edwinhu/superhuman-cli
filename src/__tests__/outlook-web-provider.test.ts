/**
 * Tests for Microsoft -> Outlook Web routing and the OutlookWebProvider shim.
 *
 * SUPERHUMAN_CLI_CONFIG_DIR is set BEFORE importing so both the token cache
 * (token-api) and the OWA broker (owa-token) read an isolated temp dir.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = mkdtempSync(join(tmpdir(), "owa-provider-test-"));
process.env.SUPERHUMAN_CLI_CONFIG_DIR = TEST_DIR;

import { resolveProvider } from "../connection-provider";
import { OutlookWebProvider } from "../outlook-web-provider";
import { SuperhumanProvider } from "../superhuman-provider";
import {
  clearTokenCache,
  setTokenCacheForTest,
  type TokenInfo,
} from "../token-api";
import { clearOwaMemCacheForTest } from "../owa-token";

function seedOwaCache(map: Record<string, any>) {
  writeFileSync(join(TEST_DIR, "owa-tokens.json"), JSON.stringify(map));
}

function clearOwaCache() {
  try {
    rmSync(join(TEST_DIR, "owa-tokens.json"));
  } catch {}
}

beforeEach(() => {
  clearTokenCache();
  clearOwaMemCacheForTest();
  clearOwaCache();
});

afterEach(() => {
  clearTokenCache();
  clearOwaMemCacheForTest();
  clearOwaCache();
});

describe("providerFromToken: Microsoft -> OutlookWebProvider", () => {
  test("a microsoft cached token routes to OutlookWebProvider", async () => {
    const token: TokenInfo = {
      accessToken: "dead-oauth",
      email: "ehu@law.virginia.edu",
      expires: Date.now() + 3600_000,
      isMicrosoft: true,
    };
    setTokenCacheForTest(token.email, token);

    const provider = await resolveProvider({ account: "ehu@law.virginia.edu" });
    expect(provider).toBeInstanceOf(OutlookWebProvider);
  });

  test("microsoft wins even when a (stale) superhumanToken is present", async () => {
    const token: TokenInfo = {
      accessToken: "dead-oauth",
      email: "ehu@law.virginia.edu",
      expires: Date.now() + 3600_000,
      isMicrosoft: true,
      superhumanToken: { token: "stale-dead-jwt", expires: Date.now() + 3600_000 },
    };
    setTokenCacheForTest(token.email, token);

    const provider = await resolveProvider({ account: "ehu@law.virginia.edu" });
    expect(provider).toBeInstanceOf(OutlookWebProvider);
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
