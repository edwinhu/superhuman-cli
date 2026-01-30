import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import {
  connectToSuperhuman,
  disconnect,
  type SuperhumanConnection,
} from "../superhuman-api";
import { listAccounts, switchAccount, type Account, type SwitchResult } from "../accounts";
import { formatAccountsList, formatAccountsJson } from "../cli";
import { accountsHandler, switchAccountHandler } from "../mcp/tools";

const CDP_PORT = 9333;

describe("accounts", () => {
  let conn: SuperhumanConnection | null = null;

  beforeAll(async () => {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error(
        "Could not connect to Superhuman. Make sure it is running with --remote-debugging-port=9333"
      );
    }
  });

  afterAll(async () => {
    if (conn) {
      await disconnect(conn);
    }
  });

  test("listAccounts returns array of accounts", async () => {
    if (!conn) throw new Error("No connection");

    const accounts = await listAccounts(conn);

    // Should return an array
    expect(Array.isArray(accounts)).toBe(true);

    // Should have at least one account
    expect(accounts.length).toBeGreaterThan(0);

    // Verify account structure
    const account = accounts[0];
    expect(account).toHaveProperty("email");
    expect(account).toHaveProperty("isCurrent");
    expect(typeof account.email).toBe("string");
    expect(typeof account.isCurrent).toBe("boolean");

    // Email should be non-empty and look like an email
    expect(account.email.length).toBeGreaterThan(0);
    expect(account.email).toContain("@");
  });

  test("exactly one account is marked as current", async () => {
    if (!conn) throw new Error("No connection");

    const accounts = await listAccounts(conn);

    // Exactly one account should have isCurrent=true
    const currentAccounts = accounts.filter((a) => a.isCurrent);
    expect(currentAccounts.length).toBe(1);
  });

  test("switchAccount switches to a different account", async () => {
    if (!conn) throw new Error("No connection");

    // Get current accounts
    const accounts = await listAccounts(conn);
    expect(accounts.length).toBeGreaterThan(1); // Need at least 2 accounts to switch

    // Find current account and a different account to switch to
    const currentAccount = accounts.find((a) => a.isCurrent);
    const targetAccount = accounts.find((a) => !a.isCurrent);

    if (!currentAccount || !targetAccount) {
      throw new Error("Need at least 2 accounts to test switching");
    }

    // Switch to the target account
    const result = await switchAccount(conn, targetAccount.email);

    // Verify the switch was successful
    expect(result.success).toBe(true);
    expect(result.email).toBe(targetAccount.email);

    // Verify via listAccounts that the switch occurred
    const accountsAfter = await listAccounts(conn);
    const newCurrent = accountsAfter.find((a) => a.isCurrent);
    expect(newCurrent?.email).toBe(targetAccount.email);
  });

  test("switchAccount round-trip returns to original account", async () => {
    if (!conn) throw new Error("No connection");

    // Get current accounts (note: after previous test, current may have changed)
    const accounts = await listAccounts(conn);
    expect(accounts.length).toBeGreaterThan(1);

    const currentAccount = accounts.find((a) => a.isCurrent);
    const targetAccount = accounts.find((a) => !a.isCurrent);

    if (!currentAccount || !targetAccount) {
      throw new Error("Need at least 2 accounts to test switching");
    }

    // Switch to target
    const result1 = await switchAccount(conn, targetAccount.email);
    expect(result1.success).toBe(true);
    expect(result1.email).toBe(targetAccount.email);

    // Switch back to original
    const result2 = await switchAccount(conn, currentAccount.email);
    expect(result2.success).toBe(true);
    expect(result2.email).toBe(currentAccount.email);
  });
});

describe("CLI formatting functions", () => {
  const mockAccounts: Account[] = [
    { email: "eddyhu@gmail.com", isCurrent: false },
    { email: "ehu@law.virginia.edu", isCurrent: true },
    { email: "eh2889@nyu.edu", isCurrent: false },
  ];

  describe("formatAccountsList", () => {
    test("formats accounts with 1-based index and current marker", () => {
      const output = formatAccountsList(mockAccounts);
      const lines = output.split("\n");

      expect(lines.length).toBe(3);
      expect(lines[0]).toBe("  1. eddyhu@gmail.com");
      expect(lines[1]).toBe("* 2. ehu@law.virginia.edu (current)");
      expect(lines[2]).toBe("  3. eh2889@nyu.edu");
    });

    test("handles empty accounts array", () => {
      const output = formatAccountsList([]);
      expect(output).toBe("");
    });

    test("handles single account that is current", () => {
      const output = formatAccountsList([{ email: "test@example.com", isCurrent: true }]);
      expect(output).toBe("* 1. test@example.com (current)");
    });
  });

  describe("formatAccountsJson", () => {
    test("formats accounts as valid JSON array", () => {
      const output = formatAccountsJson(mockAccounts);
      const parsed = JSON.parse(output);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3);
      expect(parsed[0]).toEqual({ email: "eddyhu@gmail.com", isCurrent: false });
      expect(parsed[1]).toEqual({ email: "ehu@law.virginia.edu", isCurrent: true });
      expect(parsed[2]).toEqual({ email: "eh2889@nyu.edu", isCurrent: false });
    });

    test("handles empty accounts array", () => {
      const output = formatAccountsJson([]);
      expect(output).toBe("[]");
    });
  });
});

describe("MCP account handlers", () => {
  let conn: SuperhumanConnection | null = null;

  beforeAll(async () => {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error(
        "Could not connect to Superhuman. Make sure it is running with --remote-debugging-port=9333"
      );
    }
  });

  afterAll(async () => {
    if (conn) {
      await disconnect(conn);
    }
  });

  describe("accountsHandler", () => {
    test("returns ToolResult with accounts list", async () => {
      const result = await accountsHandler({});

      // Should return a ToolResult object
      expect(result).toHaveProperty("content");
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0]).toHaveProperty("type", "text");
      expect(result.content[0]).toHaveProperty("text");

      // Should not be an error
      expect(result.isError).toBeUndefined();

      // Should contain account info in the text
      const text = result.content[0].text;
      expect(text).toContain("@"); // Should have email addresses
    });

    test("marks current account in output", async () => {
      const result = await accountsHandler({});
      const text = result.content[0].text;

      // Should have a current marker
      expect(text).toContain("(current)");
    });
  });

  describe("switchAccountHandler", () => {
    test("switches account by email address", async () => {
      // First get accounts to find a target
      const accounts = await listAccounts(conn!);
      expect(accounts.length).toBeGreaterThan(1);

      const targetAccount = accounts.find((a) => !a.isCurrent);
      if (!targetAccount) {
        throw new Error("Need at least 2 accounts to test switching");
      }

      const result = await switchAccountHandler({ account: targetAccount.email });

      // Should return success
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Switched to");
      expect(result.content[0].text).toContain(targetAccount.email);
    });

    test("switches account by index (1-based)", async () => {
      // Get accounts to know what index to use
      const accounts = await listAccounts(conn!);
      expect(accounts.length).toBeGreaterThan(1);

      const currentIndex = accounts.findIndex((a) => a.isCurrent);
      // Pick a different index (1-based)
      const targetIndex = currentIndex === 0 ? 2 : 1;
      const targetEmail = accounts[targetIndex - 1].email;

      const result = await switchAccountHandler({ account: String(targetIndex) });

      // Should return success
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Switched to");
      expect(result.content[0].text).toContain(targetEmail);
    });

    test("returns error for invalid account identifier", async () => {
      const result = await switchAccountHandler({ account: "nonexistent@example.com" });

      // Should be an error
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });

    test("returns error for out-of-range index", async () => {
      const result = await switchAccountHandler({ account: "999" });

      // Should be an error
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });
});
