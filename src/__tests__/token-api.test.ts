// src/__tests__/token-api.test.ts
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { connectToSuperhuman, disconnect, type SuperhumanConnection } from "../superhuman-api";
import { extractToken, getToken, clearTokenCache, setTokenCacheForTest, gmailFetch, msgraphFetch, searchContactsDirect, type TokenInfo } from "../token-api";
import { listAccounts } from "../accounts";

const CDP_PORT = 9333;

describe("token-api", () => {
  let conn: SuperhumanConnection | null = null;

  beforeAll(async () => {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman");
    }
  });

  afterAll(async () => {
    if (conn) await disconnect(conn);
  });

  test("extractToken returns token info for account", async () => {
    if (!conn) throw new Error("No connection");

    // Get an account to test with
    const accounts = await listAccounts(conn);
    expect(accounts.length).toBeGreaterThan(0);

    const testEmail = accounts[0].email;
    const tokenInfo = await extractToken(conn, testEmail);

    expect(tokenInfo).toHaveProperty("accessToken");
    expect(tokenInfo).toHaveProperty("email", testEmail);
    expect(tokenInfo).toHaveProperty("expires");
    expect(tokenInfo).toHaveProperty("isMicrosoft");
    expect(typeof tokenInfo.accessToken).toBe("string");
    expect(tokenInfo.accessToken.length).toBeGreaterThan(10);
    expect(typeof tokenInfo.expires).toBe("number");
    expect(tokenInfo.expires).toBeGreaterThan(Date.now());
  });

  test("getToken returns cached token on second call", async () => {
    if (!conn) throw new Error("No connection");

    const accounts = await listAccounts(conn);
    expect(accounts.length).toBeGreaterThan(0);

    const testEmail = accounts[0].email;

    // Clear cache before test to ensure clean state
    clearTokenCache();

    // First call - should extract (slow)
    const start1 = Date.now();
    const token1 = await getToken(conn, testEmail);
    const time1 = Date.now() - start1;

    // Second call - should use cache (fast)
    const start2 = Date.now();
    const token2 = await getToken(conn, testEmail);
    const time2 = Date.now() - start2;

    // Same token returned
    expect(token2.accessToken).toBe(token1.accessToken);
    expect(token2.email).toBe(token1.email);

    // Second call should be significantly faster (cached)
    // First call involves account switching (~2-10s), cached should be <100ms
    expect(time2).toBeLessThan(time1);
    expect(time2).toBeLessThan(500); // Cached call should be very fast
  });

  test("clearTokenCache clears the cache", async () => {
    if (!conn) throw new Error("No connection");

    const accounts = await listAccounts(conn);
    const testEmail = accounts[0].email;

    // Get token to populate cache
    await getToken(conn, testEmail);

    // Clear cache
    clearTokenCache();

    // Next call should extract again (slow)
    const start = Date.now();
    await getToken(conn, testEmail);
    const time = Date.now() - start;

    // Should take >500ms if re-extracting (involves account switch)
    expect(time).toBeGreaterThan(500);
  });

  test("getToken refreshes expired token from cache", async () => {
    if (!conn) throw new Error("No connection");

    const accounts = await listAccounts(conn);
    const testEmail = accounts[0].email;

    // Clear cache first
    clearTokenCache();

    // Get a fresh token
    const token1 = await getToken(conn, testEmail);

    // Manually expire the cached token by modifying the cache
    const expiredToken: TokenInfo = {
      ...token1,
      expires: Date.now() - 1000, // Expired 1 second ago
    };
    setTokenCacheForTest(testEmail, expiredToken);

    // Get token again - should detect expiry and refresh
    const token2 = await getToken(conn, testEmail);

    // Token should be refreshed (expires should be in the future)
    expect(token2.expires).toBeGreaterThan(Date.now());
  }, 30000); // 30 second timeout for token refresh

  test("getToken refreshes token expiring within 5 minutes", async () => {
    if (!conn) throw new Error("No connection");

    const accounts = await listAccounts(conn);
    const testEmail = accounts[0].email;

    clearTokenCache();

    // Get a fresh token
    const token1 = await getToken(conn, testEmail);

    // Set token to expire in 2 minutes (within the 5-minute buffer)
    const soonExpiringToken: TokenInfo = {
      ...token1,
      expires: Date.now() + (2 * 60 * 1000), // 2 minutes from now
    };
    setTokenCacheForTest(testEmail, soonExpiringToken);

    // Get token again - should detect soon-expiry and refresh
    const token2 = await getToken(conn, testEmail);

    // Token should be refreshed (expires should be further in future)
    expect(token2.expires).toBeGreaterThan(Date.now() + (5 * 60 * 1000));
  }, 30000); // 30 second timeout for token refresh

  test("gmailFetch fetches Gmail profile with token", async () => {
    if (!conn) throw new Error("No connection");

    const accounts = await listAccounts(conn);
    // Find a Gmail account (not Microsoft)
    const gmailAccount = accounts.find(a => a.email.includes("gmail.com"));

    if (!gmailAccount) {
      console.log("Skipping: No Gmail account found");
      return;
    }

    clearTokenCache();
    const token = await getToken(conn, gmailAccount.email);

    // Skip if this is a Microsoft account
    if (token.isMicrosoft) {
      console.log("Skipping: Account is Microsoft, not Gmail");
      return;
    }

    // Fetch Gmail profile using direct API
    const profile = await gmailFetch(token.accessToken, "/profile");

    expect(profile).toHaveProperty("emailAddress");
    expect(profile.emailAddress).toBe(gmailAccount.email);
  });

  test("gmailFetch returns null on 401 unauthorized", async () => {
    // Test with invalid token
    const result = await gmailFetch("invalid_token_12345", "/profile");

    // Should return null on auth error (not throw)
    expect(result).toBeNull();
  });

  test("msgraphFetch fetches MS Graph profile with token", async () => {
    if (!conn) throw new Error("No connection");

    const accounts = await listAccounts(conn);

    // We need to find a Microsoft account - check each one
    clearTokenCache();

    let msAccount: { email: string } | null = null;
    let msToken: TokenInfo | null = null;

    for (const account of accounts) {
      const token = await getToken(conn, account.email);
      if (token.isMicrosoft) {
        msAccount = account;
        msToken = token;
        break;
      }
    }

    if (!msAccount || !msToken) {
      console.log("Skipping: No Microsoft account found");
      return;
    }

    // Fetch MS Graph profile using direct API
    const profile = await msgraphFetch(msToken.accessToken, "/me");

    expect(profile).toHaveProperty("mail");
    // MS Graph may return mail or userPrincipalName
    const email = profile.mail || profile.userPrincipalName;
    expect(email.toLowerCase()).toBe(msAccount.email.toLowerCase());
  }, 60000); // 60 second timeout - iterates through accounts to find Microsoft one

  test("msgraphFetch returns null on 401 unauthorized", async () => {
    // Test with invalid token
    const result = await msgraphFetch("invalid_token_12345", "/me");

    // Should return null on auth error (not throw)
    expect(result).toBeNull();
  });

  describe("contacts search with --account", () => {
    test("searchContactsDirect returns contacts from Gmail account", async () => {
      if (!conn) throw new Error("No connection");

      const accounts = await listAccounts(conn);
      const gmailAccount = accounts.find(a => a.email.includes("gmail.com"));

      if (!gmailAccount) {
        console.log("Skipping: No Gmail account found");
        return;
      }

      clearTokenCache();
      const token = await getToken(conn, gmailAccount.email);

      if (token.isMicrosoft) {
        console.log("Skipping: Account is Microsoft");
        return;
      }

      // Search contacts using direct API
      const contacts = await searchContactsDirect(token, "a");

      expect(Array.isArray(contacts)).toBe(true);
      // Should return some contacts (assuming the account has contacts)
      // If no contacts, that's OK - the API call worked
    }, 30000);

    test("searchContactsDirect returns contacts from MS Graph account", async () => {
      if (!conn) throw new Error("No connection");

      const accounts = await listAccounts(conn);

      clearTokenCache();

      let msToken: TokenInfo | null = null;

      for (const account of accounts) {
        const token = await getToken(conn, account.email);
        if (token.isMicrosoft) {
          msToken = token;
          break;
        }
      }

      if (!msToken) {
        console.log("Skipping: No Microsoft account found");
        return;
      }

      // Search contacts using direct API
      const contacts = await searchContactsDirect(msToken, "a");

      expect(Array.isArray(contacts)).toBe(true);
    }, 60000);
  });
});
