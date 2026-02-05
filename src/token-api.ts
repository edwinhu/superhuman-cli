/**
 * Token API Module
 *
 * Direct OAuth token extraction and API calls for Gmail/Microsoft Graph.
 * Bypasses Superhuman's DI container for multi-account support.
 */

import type { SuperhumanConnection } from "./superhuman-api";
import { listAccounts, switchAccount } from "./accounts";
import type { Contact } from "./contacts";
import type { InboxThread } from "./inbox";

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

/**
 * Gmail API response types for messages.list
 */
interface GmailMessagesListResponse {
  messages?: Array<{
    id: string;
    threadId: string;
  }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/**
 * Gmail API response types for threads.get
 */
interface GmailThreadResponse {
  id: string;
  historyId: string;
  messages: Array<{
    id: string;
    threadId: string;
    labelIds: string[];
    snippet: string;
    payload: {
      headers: Array<{
        name: string;
        value: string;
      }>;
    };
    internalDate: string;
  }>;
}

/**
 * Microsoft Graph API response types for messages search
 */
interface MSGraphMessagesResponse {
  value: Array<{
    id: string;
    conversationId: string;
    subject: string;
    from: {
      emailAddress: {
        name: string;
        address: string;
      };
    };
    receivedDateTime: string;
    bodyPreview: string;
  }>;
  "@odata.nextLink"?: string;
}

/**
 * Search emails using direct Gmail/MS Graph API.
 *
 * This bypasses Superhuman's search which ignores the query parameter.
 * Uses Gmail's messages.list with q parameter or MS Graph's search endpoint.
 *
 * @param token - Token info with accessToken and isMicrosoft flag
 * @param query - Gmail search query (e.g., "from:anthropic", "subject:meeting")
 * @param limit - Maximum results (default 10)
 * @returns Array of InboxThread objects
 */
export async function searchGmailDirect(
  token: TokenInfo,
  query: string,
  limit: number = 10
): Promise<InboxThread[]> {
  if (token.isMicrosoft) {
    return searchMSGraphDirect(token, query, limit);
  }

  // Step 1: Search for messages matching the query
  const searchPath = `/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`;
  const searchResult = await gmailFetch(token.accessToken, searchPath) as GmailMessagesListResponse | null;

  if (!searchResult || !searchResult.messages || searchResult.messages.length === 0) {
    return [];
  }

  // Step 2: Get unique thread IDs (multiple messages may belong to same thread)
  const threadIds = [...new Set(searchResult.messages.map(m => m.threadId))];

  // Step 3: Fetch thread details for each unique thread
  const threads: InboxThread[] = [];

  for (const threadId of threadIds.slice(0, limit)) {
    const threadPath = `/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
    const threadResult = await gmailFetch(token.accessToken, threadPath) as GmailThreadResponse | null;

    if (!threadResult || !threadResult.messages || threadResult.messages.length === 0) {
      continue;
    }

    // Get the last message in the thread for display
    const lastMessage = threadResult.messages[threadResult.messages.length - 1];
    const headers = lastMessage.payload.headers;

    // Extract headers
    const subjectHeader = headers.find(h => h.name.toLowerCase() === "subject");
    const fromHeader = headers.find(h => h.name.toLowerCase() === "from");
    const dateHeader = headers.find(h => h.name.toLowerCase() === "date");

    // Parse the From header (format: "Name <email>" or just "email")
    const fromValue = fromHeader?.value || "";
    const fromMatch = fromValue.match(/^(?:"?([^"<]*)"?\s*)?<?([^>]+)>?$/);
    const fromName = fromMatch?.[1]?.trim() || "";
    const fromEmail = fromMatch?.[2]?.trim() || fromValue;

    threads.push({
      id: threadResult.id,
      subject: subjectHeader?.value || "(no subject)",
      from: {
        email: fromEmail,
        name: fromName,
      },
      date: dateHeader?.value || new Date(parseInt(lastMessage.internalDate)).toISOString(),
      snippet: lastMessage.snippet || "",
      labelIds: lastMessage.labelIds || [],
      messageCount: threadResult.messages.length,
    });
  }

  return threads;
}

/**
 * Search emails using MS Graph API (for Microsoft accounts).
 *
 * @param token - Token info with accessToken
 * @param query - Search query
 * @param limit - Maximum results
 * @returns Array of InboxThread objects
 */
async function searchMSGraphDirect(
  token: TokenInfo,
  query: string,
  limit: number
): Promise<InboxThread[]> {
  // MS Graph uses $search for full-text search
  const searchPath = `/me/messages?$search="${encodeURIComponent(query)}"&$top=${limit}&$select=id,conversationId,subject,from,receivedDateTime,bodyPreview`;
  const result = await msgraphFetch(token.accessToken, searchPath) as MSGraphMessagesResponse | null;

  if (!result || !result.value || result.value.length === 0) {
    return [];
  }

  // Group messages by conversationId (MS Graph's equivalent of threadId)
  const conversationMap = new Map<string, typeof result.value>();

  for (const message of result.value) {
    const existing = conversationMap.get(message.conversationId);
    if (!existing) {
      conversationMap.set(message.conversationId, [message]);
    } else {
      existing.push(message);
    }
  }

  const threads: InboxThread[] = [];

  for (const [conversationId, messages] of conversationMap) {
    // Sort by date descending and get the latest
    messages.sort((a, b) =>
      new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime()
    );
    const latestMessage = messages[0];

    threads.push({
      id: conversationId,
      subject: latestMessage.subject || "(no subject)",
      from: {
        email: latestMessage.from?.emailAddress?.address || "",
        name: latestMessage.from?.emailAddress?.name || "",
      },
      date: latestMessage.receivedDateTime,
      snippet: latestMessage.bodyPreview || "",
      labelIds: [], // MS Graph doesn't have labelIds in the same way
      messageCount: messages.length,
    });

    if (threads.length >= limit) {
      break;
    }
  }

  return threads;
}
