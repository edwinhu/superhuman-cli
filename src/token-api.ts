/**
 * Token API Module
 *
 * Direct OAuth token extraction and API calls for Gmail/Microsoft Graph.
 * Bypasses Superhuman's DI container for multi-account support.
 */

import type { SuperhumanConnection } from "./superhuman-api";
import { listAccounts, switchAccount } from "./accounts";
import type { Contact } from "./contacts";

export interface TokenInfo {
  accessToken: string;
  email: string;
  expires: number;
  isMicrosoft: boolean;
}

/**
 * Extract OAuth token for a specific account.
 *
 * Switches to the account and extracts credential._authData.
 * Returns token info with expiry timestamp.
 */
export async function extractToken(
  conn: SuperhumanConnection,
  email: string
): Promise<TokenInfo> {
  const { Runtime } = conn;

  // Verify account exists
  const accounts = await listAccounts(conn);
  const accountExists = accounts.some((a) => a.email === email);

  if (!accountExists) {
    const available = accounts.map((a) => a.email).join(", ");
    throw new Error(`Account not found: ${email}. Available: ${available}`);
  }

  // Switch to the target account
  const switchResult = await switchAccount(conn, email);
  if (!switchResult.success) {
    throw new Error(`Failed to switch to account: ${email}`);
  }

  // Wait for account to fully load
  await new Promise((r) => setTimeout(r, 1000));

  // Extract token from credential._authData
  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const ga = window.GoogleAccount;
          const authData = ga?.credential?._authData;
          const di = ga?.di;

          if (!authData?.accessToken) {
            return { error: "No access token found" };
          }

          return {
            accessToken: authData.accessToken,
            email: ga?.emailAddress || '',
            expires: authData.expires || (Date.now() + 3600000),
            isMicrosoft: !!di?.get?.('isMicrosoft'),
          };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
  });

  const value = result.result.value as TokenInfo | { error: string };

  if ("error" in value) {
    throw new Error(`Token extraction failed: ${value.error}`);
  }

  return value;
}

// In-memory token cache
const tokenCache = new Map<string, TokenInfo>();

/**
 * Get OAuth token for an account, using cache if available.
 *
 * Proactively refreshes tokens that are expired or expiring soon
 * (within 5 minutes) to avoid API failures.
 *
 * @param conn - Superhuman connection
 * @param email - Account email to get token for
 * @returns TokenInfo from cache or freshly extracted
 */
export async function getToken(
  conn: SuperhumanConnection,
  email: string
): Promise<TokenInfo> {
  // Check cache first
  const cached = tokenCache.get(email);

  if (cached) {
    // Check if token is expired or expiring soon (within 5 minutes)
    const bufferMs = 5 * 60 * 1000; // 5 minutes
    const isExpiredOrExpiring = cached.expires < Date.now() + bufferMs;

    if (!isExpiredOrExpiring) {
      return cached;
    }
    // Token expired or expiring soon, fall through to extract fresh
  }

  // Extract fresh token
  const token = await extractToken(conn, email);

  // Cache it
  tokenCache.set(email, token);

  return token;
}

/**
 * Clear the token cache.
 * Useful for testing or forcing token refresh.
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * Test helper: Set token in cache directly.
 * Only use in tests to simulate expiry scenarios.
 */
export function setTokenCacheForTest(email: string, token: TokenInfo): void {
  tokenCache.set(email, token);
}

const GMAIL_API_BASE = "https://www.googleapis.com/gmail/v1/users/me";
const MSGRAPH_API_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Make a direct fetch call to Gmail API.
 *
 * @param token - OAuth access token
 * @param path - API path (e.g., "/profile", "/messages")
 * @param options - Additional fetch options
 * @returns Response JSON or null on 401 unauthorized
 */
export async function gmailFetch(
  token: string,
  path: string,
  options?: RequestInit
): Promise<any | null> {
  const url = `${GMAIL_API_BASE}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  // Return null on unauthorized (caller should refresh token)
  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Gmail API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Make a direct fetch call to Microsoft Graph API.
 *
 * @param token - OAuth access token
 * @param path - API path (e.g., "/me", "/me/contacts")
 * @param options - Additional fetch options
 * @returns Response JSON or null on 401 unauthorized
 */
export async function msgraphFetch(
  token: string,
  path: string,
  options?: RequestInit
): Promise<any | null> {
  const url = `${MSGRAPH_API_BASE}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  // Return null on unauthorized (caller should refresh token)
  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`MS Graph API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Search contacts using direct API (Gmail or MS Graph).
 *
 * @param token - Token info with accessToken and isMicrosoft flag
 * @param query - Search query
 * @param limit - Maximum results (default 20)
 * @returns Array of Contact objects
 */
export async function searchContactsDirect(
  token: TokenInfo,
  query: string,
  limit: number = 20
): Promise<Contact[]> {
  if (token.isMicrosoft) {
    // MS Graph People API search
    const result = await msgraphFetch(
      token.accessToken,
      `/me/people?$search="${encodeURIComponent(query)}"&$top=${limit}`
    );

    if (!result || !result.value) {
      return [];
    }

    return result.value.map((p: any) => ({
      email: p.scoredEmailAddresses?.[0]?.address || p.userPrincipalName || "",
      name: p.displayName || "",
    })).filter((c: Contact) => c.email);
  } else {
    // Gmail People API (Google Contacts)
    // Note: Gmail API doesn't have direct contact search, use Google People API
    const response = await fetch(
      `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(query)}&readMask=names,emailAddresses&pageSize=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
        },
      }
    );

    if (response.status === 401) {
      return [];
    }

    if (!response.ok) {
      // Fall back to empty array on error
      console.error("Google People API error:", response.status);
      return [];
    }

    const data = await response.json();

    if (!data.results) {
      return [];
    }

    return data.results.map((r: any) => ({
      email: r.person?.emailAddresses?.[0]?.value || "",
      name: r.person?.names?.[0]?.displayName || "",
    })).filter((c: Contact) => c.email);
  }
}
