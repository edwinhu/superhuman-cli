// src/__tests__/cdp-integration.test.ts
// Integration tests that require Superhuman running with --remote-debugging-port=9333
// Run manually: bun test src/__tests__/cdp-integration.test.ts
//
// These tests are SKIPPED in CI and normal `bun test` runs.
// They exercise CDP-dependent functionality: account listing/switching.
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  connectToSuperhuman,
  disconnect,
  type SuperhumanConnection,
} from "../superhuman-api";
import { listAccounts, switchAccount } from "../accounts";

const CDP_PORT = 9333;

// Skip all tests if Superhuman is not running
let conn: SuperhumanConnection | null = null;
let skip = false;

beforeAll(async () => {
  try {
    conn = await connectToSuperhuman(CDP_PORT, false); // don't auto-launch in tests
    if (!conn) skip = true;
  } catch {
    skip = true;
  }
});

afterAll(async () => {
  if (conn) await disconnect(conn);
});

describe("accounts (CDP integration)", () => {
  test("listAccounts returns array of accounts", async () => {
    if (skip || !conn) return; // skip if no CDP

    const accounts = await listAccounts(conn);

    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThan(0);

    const account = accounts[0]!;
    expect(account).toHaveProperty("email");
    expect(account).toHaveProperty("isCurrent");
    expect(typeof account.email).toBe("string");
    expect(typeof account.isCurrent).toBe("boolean");
    expect(account.email).toContain("@");
  });

  test("exactly one account is marked as current", async () => {
    if (skip || !conn) return;

    const accounts = await listAccounts(conn);
    const currentAccounts = accounts.filter((a) => a.isCurrent);
    expect(currentAccounts.length).toBe(1);
  });

  test("switchAccount switches to a different account", async () => {
    if (skip || !conn) return;

    const accounts = await listAccounts(conn);
    if (accounts.length < 2) return; // need 2+ accounts

    const currentAccount = accounts.find((a) => a.isCurrent);
    const targetAccount = accounts.find((a) => !a.isCurrent);
    if (!currentAccount || !targetAccount) return;

    const result = await switchAccount(conn, targetAccount.email);
    expect(result.success).toBe(true);
    expect(result.email).toBe(targetAccount.email);

    const accountsAfter = await listAccounts(conn);
    const newCurrent = accountsAfter.find((a) => a.isCurrent);
    expect(newCurrent?.email).toBe(targetAccount.email);
  });

  test("switchAccount round-trip returns to original account", async () => {
    if (skip || !conn) return;

    const accounts = await listAccounts(conn);
    if (accounts.length < 2) return;

    const currentAccount = accounts.find((a) => a.isCurrent);
    const targetAccount = accounts.find((a) => !a.isCurrent);
    if (!currentAccount || !targetAccount) return;

    const result1 = await switchAccount(conn, targetAccount.email);
    expect(result1.success).toBe(true);

    const result2 = await switchAccount(conn, currentAccount.email);
    expect(result2.success).toBe(true);
    expect(result2.email).toBe(currentAccount.email);
  });
});
