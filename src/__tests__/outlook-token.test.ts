/**
 * Tests for owa-token.ts — the disk-cache + freshness logic of the OWA token
 * broker (the CDP scrape path is exercised live, not here).
 *
 * Isolated via SUPERHUMAN_CLI_CONFIG_DIR so the broker reads a temp dir, never
 * the machine's real ~/.config/superhuman-cli/owa-tokens.json.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOwaToken, listOwaAccounts, clearOwaMemCacheForTest } from "../owa-token";

let dir: string;

// HERMETIC: restore SUPERHUMAN_CLI_CONFIG_DIR to its prior value (not just
// delete it) so this file never clobbers what a later-loaded test relies on.
const HAD_CONFIG_DIR = Object.prototype.hasOwnProperty.call(
  process.env,
  "SUPERHUMAN_CLI_CONFIG_DIR"
);
const PRIOR_CONFIG_DIR = process.env.SUPERHUMAN_CLI_CONFIG_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "owa-token-test-"));
  process.env.SUPERHUMAN_CLI_CONFIG_DIR = dir;
  clearOwaMemCacheForTest();
});

afterEach(async () => {
  if (HAD_CONFIG_DIR) process.env.SUPERHUMAN_CLI_CONFIG_DIR = PRIOR_CONFIG_DIR;
  else delete process.env.SUPERHUMAN_CLI_CONFIG_DIR;
  clearOwaMemCacheForTest();
  await rm(dir, { recursive: true, force: true });
});

async function seed(map: Record<string, any>) {
  await writeFile(join(dir, "owa-tokens.json"), JSON.stringify(map));
}

describe("listOwaAccounts", () => {
  test("returns emails from the disk cache", async () => {
    await seed({
      "ehu@law.virginia.edu": {
        accessToken: "tok",
        email: "ehu@law.virginia.edu",
        expiresOn: Date.now() + 3600_000,
      },
    });
    expect(await listOwaAccounts()).toEqual(["ehu@law.virginia.edu"]);
  });

  test("empty when no cache file", async () => {
    expect(await listOwaAccounts()).toEqual([]);
  });
});

describe("getOwaToken (disk-cache hit)", () => {
  test("returns a fresh cached token without touching CDP", async () => {
    const expiresOn = Date.now() + 3600_000;
    await seed({
      "ehu@law.virginia.edu": {
        accessToken: "fresh-token",
        email: "ehu@law.virginia.edu",
        expiresOn,
      },
    });
    const tok = await getOwaToken("ehu@law.virginia.edu");
    expect(tok.accessToken).toBe("fresh-token");
    expect(tok.email).toBe("ehu@law.virginia.edu");
    expect(tok.expiresOn).toBe(expiresOn);
  });

  test("no argument returns the only fresh account in the cache", async () => {
    const expiresOn = Date.now() + 3600_000;
    await seed({
      "ehu@law.virginia.edu": {
        accessToken: "t",
        email: "ehu@law.virginia.edu",
        expiresOn,
      },
    });
    const tok = await getOwaToken();
    expect(tok.email).toBe("ehu@law.virginia.edu");
  });
});

describe("getOwaToken (single-session fallback: UPN cache key vs SMTP --account)", () => {
  test("a non-matching SMTP address reuses the single fresh token (no CDP scrape)", async () => {
    // The token is keyed by its UPN, but the caller asks by SMTP address —
    // the two identify the same one signed-in mailbox. Must NOT re-scrape.
    const expiresOn = Date.now() + 3600_000;
    await seed({
      "vwh7mb@lawschool.virginia.edu": {
        accessToken: "the-token",
        email: "vwh7mb@lawschool.virginia.edu",
        expiresOn,
      },
    });
    const tok = await getOwaToken("ehu@law.virginia.edu");
    expect(tok.accessToken).toBe("the-token");
    expect(tok.email).toBe("vwh7mb@lawschool.virginia.edu");
  });

  test("aliases the requested SMTP address to the token so the next lookup hits directly", async () => {
    const expiresOn = Date.now() + 3600_000;
    await seed({
      "vwh7mb@lawschool.virginia.edu": {
        accessToken: "the-token",
        email: "vwh7mb@lawschool.virginia.edu",
        expiresOn,
      },
    });
    await getOwaToken("ehu@law.virginia.edu");
    // The disk cache should now also be keyed by the SMTP address.
    expect(await listOwaAccounts()).toContain("vwh7mb@lawschool.virginia.edu");
    const raw = JSON.parse(
      await Bun.file(join(dir, "owa-tokens.json")).text()
    );
    expect(raw["ehu@law.virginia.edu"]?.accessToken).toBe("the-token");
  });

  test("with several fresh tokens it does NOT guess — falls through to the (absent) CDP scrape", async () => {
    // Ambiguous: two mailboxes, neither matches the requested key. We must not
    // silently return the wrong one; with no browser this surfaces as an error.
    const expiresOn = Date.now() + 3600_000;
    await seed({
      "a@x.com": { accessToken: "a", email: "a@x.com", expiresOn },
      "b@y.com": { accessToken: "b", email: "b@y.com", expiresOn },
    });
    // Pin CDP to a dead port so the scrape fails fast and never touches a real
    // browser that may be running on the default port.
    const priorPort = process.env.CDP_PORT;
    process.env.CDP_PORT = "59999";
    try {
      await expect(getOwaToken("c@z.com")).rejects.toThrow();
    } finally {
      if (priorPort === undefined) delete process.env.CDP_PORT;
      else process.env.CDP_PORT = priorPort;
    }
  });
});
