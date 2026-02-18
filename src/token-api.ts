/**
 * Token API Module
 *
 * Direct OAuth token extraction and API calls for Gmail/Microsoft Graph.
 * Bypasses Superhuman's DI container for multi-account support.
 */

import type { SuperhumanConnection, ChromeExtConnection } from "./superhuman-api";
import { listAccounts, switchAccount } from "./accounts";
import type { Contact } from "./contacts";
import type { InboxThread } from "./inbox";

export interface TokenInfo {
  accessToken: string;
  email: string;
  expires: number;
  isMicrosoft: boolean;
  // OAuth refresh token for background refresh
  refreshToken?: string;
  // Superhuman backend API fields
  userId?: string;
  idToken?: string;
  idTokenExpires?: number;
  // 4-char user prefix for generating event IDs (e.g., "4sKP")
  userPrefix?: string;
  // Superhuman backend API token (for userdata.getThreads, etc.)
  superhumanToken?: {
    token: string;
    expires: number;
  };
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
          const user = ga?.credential?.user;
          const di = ga?.di;

          if (!authData?.accessToken) {
            return { error: "No access token found" };
          }

          // Extract user prefix for event ID generation
          let userPrefix = null;
          try {
            const shUserId = ga?.labels?._settings?._cache?.userId;
            if (shUserId) {
              const suffix = shUserId.replace('user_', '');
              if (suffix.length >= 11) {
                userPrefix = suffix.substring(7, 11);
              }
            }
          } catch (_) {}

          return {
            accessToken: authData.accessToken,
            email: ga?.emailAddress || '',
            expires: authData.expires || (Date.now() + 3600000),
            isMicrosoft: !!di?.get?.('isMicrosoft'),
            // OAuth refresh token for background refresh
            refreshToken: authData.refreshToken,
            // Superhuman backend API fields
            userId: user?._id,
            idToken: authData.idToken,
            idTokenExpires: authData.expires,
            userPrefix: userPrefix,
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

// ============================================================================
// Chrome Extension Token Extraction
// ============================================================================

interface CapturedToken {
  url: string;
  token: string;
  email: string; // from x-superhuman-user-email header
}

/**
 * Pick the Superhuman backend (Firebase) token from a list of captured JWTs.
 * Prefers tokens from /~backend/ endpoints, then Firebase issuer, then first available.
 */
export function selectBestToken(
  tokens: CapturedToken[],
  email: string
): string | null {
  // Filter to tokens for the target account
  const forAccount = tokens.filter((t) => t.email === email || !t.email);

  // Prefer token used on /~backend/ endpoints
  const backendToken = forAccount.find((t) => t.url.includes("/~backend/"));
  if (backendToken) return backendToken.token;

  // Fallback: find Firebase token by JWT issuer
  for (const t of forAccount) {
    try {
      const payload = JSON.parse(
        Buffer.from(t.token.split(".")[1], "base64url").toString()
      );
      if (payload.iss?.includes("securetoken.googleapis.com")) {
        return t.token;
      }
    } catch {}
  }

  // Last resort: return first token with auth
  return forAccount[0]?.token ?? null;
}

/**
 * Extract tokens for an account via Chrome extension CDP interception.
 *
 * Intercepts network requests from the service worker to capture:
 * 1. Superhuman backend token (Firebase JWT used for /~backend/ calls)
 * 2. Provider access token (Google/Microsoft OAuth token)
 */
export async function extractTokenChrome(
  conn: ChromeExtConnection,
  email: string
): Promise<TokenInfo> {
  const { swClient, mainClient } = conn;

  // 1. Read account metadata from service worker
  const meta = await swClient.Runtime.evaluate({
    expression: `(() => {
      const bg = backgrounds[${JSON.stringify(email)}]?._accountBackground;
      if (!bg) return null;
      let userPrefix = null;
      try {
        const uid = bg.settings?._cache?.userId;
        if (uid) {
          const s = uid.replace("user_", "");
          if (s.length >= 11) userPrefix = s.substring(7, 11);
        }
      } catch {}
      return {
        userId: bg.labels?._user?._id || null,
        provider: bg.provider || "google",
        userPrefix,
      };
    })()`,
    returnByValue: true,
  });

  const metadata = meta.result.value as {
    userId: string | null;
    provider: string;
    userPrefix: string | null;
  } | null;

  if (!metadata)
    throw new Error(`Account not found in Chrome extension: ${email}`);

  const isMicrosoft = metadata.provider === "microsoft";

  // 2. Set up CDP Fetch interception on service worker to capture backend tokens
  const captured: CapturedToken[] = [];
  const { Fetch } = swClient;
  await Fetch.enable({
    patterns: [{ urlPattern: "*superhuman.com/~backend*" }],
  });

  const handler = async ({ requestId, request }: any) => {
    const auth = request.headers["Authorization"] || "";
    if (auth.startsWith("Bearer ")) {
      captured.push({
        url: request.url,
        token: auth.slice(7),
        email: request.headers["x-superhuman-user-email"] || "",
      });
    }
    try { await Fetch.continueRequest({ requestId }); } catch {}
  };
  Fetch.requestPaused(handler);

  // 3. Navigate to account and reload to trigger API calls
  await mainClient.Page.navigate({
    url: `https://mail.superhuman.com/${email}`,
  });
  await new Promise((r) => setTimeout(r, 3000));
  await mainClient.Page.reload();

  // 4. Wait for backend tokens (up to 20 seconds)
  const deadline = Date.now() + 20_000;
  while (captured.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  await Fetch.disable();

  // 5. Select best backend token
  const bestToken = selectBestToken(captured, email);

  // 6. Capture OAuth access token (provider token) via a second interception pass
  let accessToken = "";
  let accessTokenExpires = Date.now() + 3600_000;
  const providerCapture: CapturedToken[] = [];

  await Fetch.enable({
    patterns: [
      {
        urlPattern: isMicrosoft
          ? "*graph.microsoft.com*"
          : "*googleapis.com*",
      },
    ],
  });
  const providerHandler = async ({ requestId, request }: any) => {
    const auth = request.headers["Authorization"] || "";
    if (auth.startsWith("Bearer ")) {
      providerCapture.push({
        url: request.url,
        token: auth.slice(7),
        email: "",
      });
    }
    try { await Fetch.continueRequest({ requestId }); } catch {}
  };
  Fetch.requestPaused(providerHandler);

  // Trigger a lightweight API call via reload
  await mainClient.Page.reload();
  const providerDeadline = Date.now() + 15_000;
  while (providerCapture.length === 0 && Date.now() < providerDeadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  await Fetch.disable();

  if (providerCapture.length > 0) {
    accessToken = providerCapture[0].token;
    try {
      const payload = JSON.parse(
        Buffer.from(accessToken.split(".")[1], "base64url").toString()
      );
      if (payload.exp) accessTokenExpires = payload.exp * 1000;
    } catch {}
  }

  // 7. Build TokenInfo
  const tokenInfo: TokenInfo = {
    accessToken,
    email,
    expires: accessTokenExpires,
    isMicrosoft,
    userId: metadata.userId ?? undefined,
    idToken: bestToken ?? undefined,
    idTokenExpires: bestToken
      ? (() => {
          try {
            const p = JSON.parse(
              Buffer.from(bestToken.split(".")[1], "base64url").toString()
            );
            return p.exp ? p.exp * 1000 : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined,
    userPrefix: metadata.userPrefix ?? undefined,
  };

  // Cache it
  tokenCache.set(email, tokenInfo);
  return tokenInfo;
}

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

/**
 * Refresh OAuth access token using refresh token.
 *
 * Calls the appropriate OAuth endpoint (Google or Microsoft) to exchange
 * the refresh token for a new access token.
 *
 * @param token - Token info with refresh token
 * @returns Updated TokenInfo with new access token, or null on failure
 */
export async function refreshAccessToken(
  token: TokenInfo
): Promise<TokenInfo | null> {
  if (!token.refreshToken) {
    return null;
  }

  const endpoint = token.isMicrosoft
    ? "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    : "https://oauth2.googleapis.com/token";

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      }),
    });

    if (!response.ok) {
      console.error(`Token refresh failed: ${response.status}`);
      return null;
    }

    const data = await response.json();

    return {
      ...token,
      accessToken: data.access_token,
      expires: Date.now() + data.expires_in * 1000,
      refreshToken: data.refresh_token || token.refreshToken,
    };
  } catch (error) {
    console.error("Token refresh error:", error);
    return null;
  }
}

// ============================================================================
// Token Persistence
// ============================================================================

/**
 * Persisted token format for disk storage.
 */
export interface PersistedTokens {
  version: 1;
  accounts: {
    [email: string]: {
      type: "google" | "microsoft";
      accessToken: string;
      expires: number; // Unix timestamp
      userId?: string; // Superhuman user ID for API paths
      refreshToken?: string; // OAuth refresh token for background refresh
      userPrefix?: string; // 4-char user prefix for event ID generation
      superhumanToken?: {
        token: string; // idToken for Superhuman backend
        expires?: number;
      };
    };
  };
  lastUpdated: number;
}

// Config directory - evaluated at call time for testability
function getConfigDir(): string {
  return (
    process.env.SUPERHUMAN_CLI_CONFIG_DIR ||
    `${process.env.HOME}/.config/superhuman-cli`
  );
}

function getTokensFile(): string {
  return `${getConfigDir()}/tokens.json`;
}

/**
 * Save all cached tokens to disk.
 *
 * Creates config directory if needed and writes tokens.json.
 * Called by the `auth` command after extracting tokens via CDP.
 */
export async function saveTokensToDisk(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const configDir = getConfigDir();
  const tokensFile = getTokensFile();

  await mkdir(configDir, { recursive: true });

  const data: PersistedTokens = {
    version: 1,
    accounts: {},
    lastUpdated: Date.now(),
  };

  // Convert in-memory cache to persisted format
  for (const [email, token] of Array.from(tokenCache.entries())) {
    data.accounts[email] = {
      type: token.isMicrosoft ? "microsoft" : "google",
      accessToken: token.accessToken,
      expires: token.expires,
      userId: token.userId,
      refreshToken: token.refreshToken,
      userPrefix: token.userPrefix,
      superhumanToken: token.idToken ? {
        token: token.idToken,
        expires: token.idTokenExpires,
      } : undefined,
    };
  }

  await Bun.write(tokensFile, JSON.stringify(data, null, 2));
}

/**
 * Load tokens from disk into memory cache.
 *
 * Called at CLI startup to check for cached tokens before
 * attempting CDP connection.
 *
 * @returns true if tokens were loaded successfully, false otherwise
 */
export async function loadTokensFromDisk(): Promise<boolean> {
  try {
    const tokensFile = getTokensFile();
    const file = Bun.file(tokensFile);
    if (!(await file.exists())) {
      return false;
    }

    const data = (await file.json()) as PersistedTokens;

    // Validate version
    if (data.version !== 1) {
      return false;
    }

    // Populate in-memory cache
    for (const [email, account] of Object.entries(data.accounts)) {
      tokenCache.set(email, {
        accessToken: account.accessToken,
        email,
        expires: account.expires,
        isMicrosoft: account.type === "microsoft",
        userId: account.userId,
        refreshToken: account.refreshToken,
        idToken: account.superhumanToken?.token,
        idTokenExpires: account.superhumanToken?.expires,
        userPrefix: account.userPrefix,
        superhumanToken: account.superhumanToken, // Preserve full superhuman token
      });
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Check if all cached tokens are still valid.
 *
 * Returns false if cache is empty or any token is expired
 * or expiring within 5 minutes.
 */
export function hasValidCachedTokens(): boolean {
  if (tokenCache.size === 0) {
    return false;
  }

  const bufferMs = 5 * 60 * 1000; // 5 minutes
  for (const token of tokenCache.values()) {
    if (token.expires < Date.now() + bufferMs) {
      return false; // At least one token expired or expiring soon
    }
  }

  return true;
}

/**
 * Get cached token for a specific account.
 *
 * If the token is expired or expiring within 5 minutes:
 * - Attempts to refresh using the refresh token
 * - Persists the refreshed token to disk
 * - Returns undefined if refresh fails
 *
 * @param email - Account email
 * @returns Token info if valid/refreshed, undefined otherwise
 */
export async function getCachedToken(email: string): Promise<TokenInfo | undefined> {
  const token = tokenCache.get(email);
  if (!token) return undefined;

  const bufferMs = 5 * 60 * 1000; // 5 minutes
  if (token.expires < Date.now() + bufferMs) {
    // Token expired or expiring soon - try to refresh
    if (token.refreshToken) {
      const refreshed = await refreshAccessToken(token);
      if (refreshed) {
        tokenCache.set(email, refreshed);
        await saveTokensToDisk();
        return refreshed;
      }
    }
    // Refresh failed or no refresh token
    console.warn(`Token for ${email} expired. Run 'superhuman auth' to re-authenticate.`);
    return undefined;
  }

  return token;
}

/**
 * Get list of cached account emails.
 */
export function getCachedAccounts(): string[] {
  return Array.from(tokenCache.keys());
}

/**
 * Check if we have valid cached credentials for Superhuman API.
 * Requires both idToken and userId.
 */
export async function hasCachedSuperhumanCredentials(email: string): Promise<boolean> {
  const token = await getCachedToken(email);
  return !!(token?.idToken && token?.userId);
}

/**
 * Get the path to the tokens file.
 * Useful for displaying to users where tokens are stored.
 */
export function getTokensFilePath(): string {
  return getTokensFile();
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
  const threadIdSet = new Set(searchResult.messages.map(m => m.threadId));
  const threadIds = Array.from(threadIdSet);

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

  const conversationEntries = Array.from(conversationMap.entries());
  for (const [conversationId, messages] of conversationEntries) {
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

// ============================================================================
// Direct API Functions for Labels, Read Status, Archive, etc.
// ============================================================================

/**
 * Label type for direct API operations.
 */
export interface Label {
  id: string;
  name: string;
  type?: string;
}

/**
 * Attachment metadata from thread/message.
 */
export interface AttachmentInfo {
  id: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  messageId: string;
}

/**
 * Gmail thread response with full message details.
 */
interface GmailThreadFullResponse {
  id: string;
  historyId: string;
  messages: Array<{
    id: string;
    threadId: string;
    labelIds: string[];
    snippet: string;
    payload: {
      mimeType?: string;
      filename?: string;
      headers: Array<{ name: string; value: string }>;
      parts?: Array<{
        partId: string;
        mimeType: string;
        filename?: string;
        body?: {
          attachmentId?: string;
          size?: number;
          data?: string;
        };
        parts?: any[];
      }>;
      body?: {
        attachmentId?: string;
        size?: number;
        data?: string;
      };
    };
    internalDate: string;
  }>;
}

/**
 * Modify labels on a Gmail thread (add/remove labels).
 *
 * @param token - Token info with accessToken
 * @param threadId - The Gmail thread ID
 * @param addLabelIds - Label IDs to add
 * @param removeLabelIds - Label IDs to remove
 * @returns true on success
 */
export async function modifyThreadLabels(
  token: TokenInfo,
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[]
): Promise<boolean> {
  if (token.isMicrosoft) {
    throw new Error("modifyThreadLabels is Gmail-only. Use updateMessage for MS Graph.");
  }

  const path = `/threads/${threadId}/modify`;
  const body = {
    addLabelIds,
    removeLabelIds,
  };

  const result = await gmailFetch(token.accessToken, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return result !== null;
}

/**
 * Update message properties via MS Graph (isRead, flag, etc.).
 *
 * @param token - Token info with accessToken
 * @param messageId - The MS Graph message ID
 * @param updates - Properties to update
 * @returns true on success
 */
export async function updateMessage(
  token: TokenInfo,
  messageId: string,
  updates: { isRead?: boolean; flag?: { flagStatus: string } }
): Promise<boolean> {
  if (!token.isMicrosoft) {
    throw new Error("updateMessage is MS Graph-only. Use modifyThreadLabels for Gmail.");
  }

  const path = `/me/messages/${messageId}`;
  const result = await msgraphFetch(token.accessToken, path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });

  return result !== null;
}

/**
 * Move a message to a folder via MS Graph.
 *
 * @param token - Token info with accessToken
 * @param messageId - The MS Graph message ID
 * @param destinationFolderId - The target folder ID
 * @returns true on success
 */
export async function moveMessageToFolder(
  token: TokenInfo,
  messageId: string,
  destinationFolderId: string
): Promise<boolean> {
  if (!token.isMicrosoft) {
    throw new Error("moveMessageToFolder is MS Graph-only. Use modifyThreadLabels for Gmail.");
  }

  const path = `/me/messages/${messageId}/move`;
  const result = await msgraphFetch(token.accessToken, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destinationId: destinationFolderId }),
  });

  return result !== null;
}

/**
 * List all labels (Gmail) or mail folders (MS Graph).
 *
 * @param token - Token info with accessToken and isMicrosoft flag
 * @returns Array of labels/folders
 */
export async function listLabelsDirect(token: TokenInfo): Promise<Label[]> {
  if (token.isMicrosoft) {
    // MS Graph: List mail folders
    const result = await msgraphFetch(token.accessToken, "/me/mailFolders?$top=100");

    if (!result || !result.value) {
      return [];
    }

    return result.value.map((f: any) => ({
      id: f.id,
      name: f.displayName,
      type: "folder",
    }));
  } else {
    // Gmail: List labels
    const result = await gmailFetch(token.accessToken, "/labels");

    if (!result || !result.labels) {
      return [];
    }

    return result.labels.map((l: any) => ({
      id: l.id,
      name: l.name,
      type: l.type,
    }));
  }
}

/**
 * Get a specific folder by well-known name (MS Graph).
 *
 * @param token - Token info
 * @param wellKnownName - e.g., "archive", "deleteditems", "inbox"
 * @returns Folder info or null
 */
export async function getWellKnownFolder(
  token: TokenInfo,
  wellKnownName: string
): Promise<{ id: string; displayName: string } | null> {
  if (!token.isMicrosoft) {
    return null;
  }

  const result = await msgraphFetch(token.accessToken, `/me/mailFolders/${wellKnownName}`);
  if (!result) {
    return null;
  }

  return {
    id: result.id,
    displayName: result.displayName,
  };
}

/**
 * List inbox threads directly via Gmail/MS Graph API.
 *
 * @param token - Token info
 * @param limit - Maximum threads to return
 * @returns Array of InboxThread
 */
export async function listInboxDirect(
  token: TokenInfo,
  limit: number = 10
): Promise<InboxThread[]> {
  if (token.isMicrosoft) {
    // MS Graph: Get messages from Inbox folder
    const path = `/me/mailFolders/Inbox/messages?$top=${limit}&$select=id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead`;
    const result = await msgraphFetch(token.accessToken, path);

    if (!result || !result.value) {
      return [];
    }

    // Group by conversationId
    const conversationMap = new Map<string, any[]>();
    for (const msg of result.value) {
      const existing = conversationMap.get(msg.conversationId);
      if (!existing) {
        conversationMap.set(msg.conversationId, [msg]);
      } else {
        existing.push(msg);
      }
    }

    const threads: InboxThread[] = [];
    const convEntries = Array.from(conversationMap.entries());
    for (const [convId, messages] of convEntries) {
      messages.sort((a, b) =>
        new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime()
      );
      const latest = messages[0];

      threads.push({
        id: convId,
        subject: latest.subject || "(no subject)",
        from: {
          email: latest.from?.emailAddress?.address || "",
          name: latest.from?.emailAddress?.name || "",
        },
        date: latest.receivedDateTime,
        snippet: latest.bodyPreview || "",
        labelIds: latest.isRead ? [] : ["UNREAD"],
        messageCount: messages.length,
      });

      if (threads.length >= limit) break;
    }

    return threads;
  } else {
    // Gmail: Search for inbox messages
    return searchGmailDirect(token, "label:INBOX", limit);
  }
}

/**
 * Get a Gmail thread with full message details including attachments.
 *
 * @param token - Token info
 * @param threadId - The thread ID
 * @returns Thread with messages and attachment info
 */
export async function getThreadDirect(
  token: TokenInfo,
  threadId: string
): Promise<{
  id: string;
  messages: Array<{
    id: string;
    labelIds: string[];
    attachments: AttachmentInfo[];
  }>;
} | null> {
  if (token.isMicrosoft) {
    // MS Graph: Get conversation messages
    const path = `/me/messages?$filter=conversationId eq '${threadId}'&$select=id,hasAttachments&$expand=attachments`;
    const result = await msgraphFetch(token.accessToken, path);

    if (!result || !result.value) {
      return null;
    }

    return {
      id: threadId,
      messages: result.value.map((msg: any) => ({
        id: msg.id,
        labelIds: [],
        attachments: (msg.attachments || []).map((att: any) => ({
          id: att.id,
          attachmentId: att.id,
          filename: att.name,
          mimeType: att.contentType,
          size: att.size || 0,
          messageId: msg.id,
        })),
      })),
    };
  } else {
    // Gmail: Get thread with full format
    const path = `/threads/${threadId}?format=full`;
    const result = await gmailFetch(token.accessToken, path) as GmailThreadFullResponse | null;

    if (!result || !result.messages) {
      return null;
    }

    return {
      id: result.id,
      messages: result.messages.map((msg) => ({
        id: msg.id,
        labelIds: msg.labelIds || [],
        attachments: extractAttachments(msg),
      })),
    };
  }
}

/**
 * Extract attachment info from a Gmail message payload.
 */
function extractAttachments(message: GmailThreadFullResponse["messages"][0]): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];

  function processParts(parts: any[] | undefined, messageId: string) {
    if (!parts) return;

    for (const part of parts) {
      if (part.filename && part.body?.attachmentId) {
        attachments.push({
          id: part.body.attachmentId,
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType || "application/octet-stream",
          size: part.body.size || 0,
          messageId,
        });
      }

      // Recurse into nested parts
      if (part.parts) {
        processParts(part.parts, messageId);
      }
    }
  }

  // Check top-level body
  if (message.payload.body?.attachmentId && message.payload.filename) {
    attachments.push({
      id: message.payload.body.attachmentId,
      attachmentId: message.payload.body.attachmentId,
      filename: message.payload.filename || "attachment",
      mimeType: message.payload.mimeType || "application/octet-stream",
      size: message.payload.body.size || 0,
      messageId: message.id,
    });
  }

  // Process parts
  processParts(message.payload.parts, message.id);

  return attachments;
}

/**
 * Download an attachment from Gmail or MS Graph.
 *
 * @param token - Token info
 * @param messageId - The message ID containing the attachment
 * @param attachmentId - The attachment ID
 * @returns Base64-encoded attachment data and size
 */
export async function downloadAttachmentDirect(
  token: TokenInfo,
  messageId: string,
  attachmentId: string
): Promise<{ data: string; size: number }> {
  if (token.isMicrosoft) {
    // MS Graph: Get attachment content
    const path = `/me/messages/${messageId}/attachments/${attachmentId}`;
    const result = await msgraphFetch(token.accessToken, path);

    if (!result) {
      throw new Error("Failed to download attachment");
    }

    // MS Graph returns contentBytes as base64
    return {
      data: result.contentBytes || "",
      size: result.size || 0,
    };
  } else {
    // Gmail: Get attachment
    const path = `/messages/${messageId}/attachments/${attachmentId}`;
    const result = await gmailFetch(token.accessToken, path);

    if (!result) {
      throw new Error("Failed to download attachment");
    }

    // Gmail returns data as URL-safe base64, need to convert
    const urlSafeBase64 = result.data || "";
    // Convert URL-safe base64 to standard base64
    const standardBase64 = urlSafeBase64
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    return {
      data: standardBase64,
      size: result.size || 0,
    };
  }
}

/**
 * Get message IDs for a conversation (MS Graph helper).
 * MS Graph operations work on messages, not threads/conversations.
 *
 * @param token - Token info
 * @param conversationId - The conversation ID
 * @returns Array of message IDs
 */
export async function getConversationMessageIds(
  token: TokenInfo,
  conversationId: string
): Promise<string[]> {
  if (!token.isMicrosoft) {
    throw new Error("getConversationMessageIds is MS Graph-only");
  }

  const path = `/me/messages?$filter=conversationId eq '${conversationId}'&$select=id`;
  const result = await msgraphFetch(token.accessToken, path);

  if (!result || !result.value) {
    return [];
  }

  return result.value.map((m: any) => m.id);
}

/**
 * Add an attachment to a draft via MS Graph API.
 *
 * @param token - Token info
 * @param draftId - The draft/message ID
 * @param filename - Attachment filename
 * @param contentType - MIME type
 * @param base64Data - Base64-encoded attachment data
 * @returns true on success
 */
export async function addAttachmentToMsgraphDraft(
  token: TokenInfo,
  draftId: string,
  filename: string,
  contentType: string,
  base64Data: string
): Promise<boolean> {
  if (!token.isMicrosoft) {
    throw new Error("addAttachmentToMsgraphDraft is MS Graph-only");
  }

  const path = `/me/messages/${draftId}/attachments`;
  const body = {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: filename,
    contentType: contentType,
    contentBytes: base64Data,
  };

  const result = await msgraphFetch(token.accessToken, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return result !== null;
}

/**
 * Add an attachment to a Gmail draft.
 *
 * Gmail requires rebuilding the entire MIME message with attachments.
 * This function fetches the draft, adds the attachment, and updates it.
 *
 * @param token - Token info
 * @param draftId - The Gmail draft ID
 * @param filename - Attachment filename
 * @param contentType - MIME type
 * @param base64Data - Base64-encoded attachment data
 * @returns true on success
 */
export async function addAttachmentToGmailDraft(
  token: TokenInfo,
  draftId: string,
  filename: string,
  contentType: string,
  base64Data: string
): Promise<boolean> {
  if (token.isMicrosoft) {
    throw new Error("addAttachmentToGmailDraft is Gmail-only");
  }

  // Step 1: Get the existing draft
  const draftPath = `/drafts/${draftId}?format=full`;
  const draft = await gmailFetch(token.accessToken, draftPath);

  if (!draft || !draft.message) {
    throw new Error("Draft not found");
  }

  // Step 2: Extract existing message content
  const message = draft.message;
  const payload = message.payload;
  const headers = payload.headers || [];

  // Helper to get header value
  const getHeader = (name: string) =>
    headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

  const to = getHeader("To");
  const cc = getHeader("Cc");
  const bcc = getHeader("Bcc");
  const subject = getHeader("Subject");
  const from = getHeader("From");
  const inReplyTo = getHeader("In-Reply-To");
  const references = getHeader("References");

  // Extract body from the message
  let body = "";
  let isHtml = false;

  function extractBody(part: any): void {
    if (part.mimeType === "text/html" && part.body?.data) {
      body = Buffer.from(part.body.data, "base64url").toString("utf-8");
      isHtml = true;
    } else if (part.mimeType === "text/plain" && part.body?.data && !body) {
      body = Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    if (part.parts) {
      for (const p of part.parts) {
        extractBody(p);
      }
    }
  }
  extractBody(payload);

  // Collect existing attachments
  const existingAttachments: Array<{
    filename: string;
    mimeType: string;
    data: string;
  }> = [];

  async function collectAttachments(part: any): Promise<void> {
    if (part.filename && part.body?.attachmentId) {
      // Fetch the attachment data
      const attPath = `/messages/${message.id}/attachments/${part.body.attachmentId}`;
      const attData = await gmailFetch(token.accessToken, attPath);
      if (attData?.data) {
        existingAttachments.push({
          filename: part.filename,
          mimeType: part.mimeType || "application/octet-stream",
          data: attData.data.replace(/-/g, "+").replace(/_/g, "/"),
        });
      }
    }
    if (part.parts) {
      for (const p of part.parts) {
        await collectAttachments(p);
      }
    }
  }
  await collectAttachments(payload);

  // Add the new attachment
  existingAttachments.push({
    filename,
    mimeType: contentType,
    data: base64Data,
  });

  // Step 3: Build new MIME message with attachments
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const mimeHeaders = [
    "MIME-Version: 1.0",
    `From: ${from}`,
    `To: ${to}`,
  ];

  if (cc) mimeHeaders.push(`Cc: ${cc}`);
  if (bcc) mimeHeaders.push(`Bcc: ${bcc}`);
  mimeHeaders.push(`Subject: ${subject}`);
  if (inReplyTo) mimeHeaders.push(`In-Reply-To: ${inReplyTo}`);
  if (references) mimeHeaders.push(`References: ${references}`);
  mimeHeaders.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  mimeHeaders.push("");

  // Body part
  const bodyPart = [
    `--${boundary}`,
    `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=utf-8`,
    "",
    body,
  ].join("\r\n");

  // Attachment parts
  const attachmentParts = existingAttachments.map((att) => [
    `--${boundary}`,
    `Content-Type: ${att.mimeType}; name="${att.filename}"`,
    `Content-Disposition: attachment; filename="${att.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    att.data,
  ].join("\r\n")).join("\r\n");

  const fullMessage = [
    mimeHeaders.join("\r\n"),
    bodyPart,
    attachmentParts,
    `--${boundary}--`,
  ].join("\r\n");

  // Base64url encode
  const base64Message = Buffer.from(fullMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // Step 4: Update the draft
  const updatePath = `/drafts/${draftId}`;
  const updateBody: any = {
    message: { raw: base64Message },
  };

  if (message.threadId) {
    updateBody.message.threadId = message.threadId;
  }

  const response = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me${updatePath}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updateBody),
    }
  );

  return response.ok;
}

/**
 * Add an attachment to a draft (Gmail or MS Graph).
 *
 * @param token - Token info
 * @param draftId - The draft ID
 * @param filename - Attachment filename
 * @param contentType - MIME type
 * @param base64Data - Base64-encoded attachment data
 * @returns true on success
 */
export async function addAttachmentToDraft(
  token: TokenInfo,
  draftId: string,
  filename: string,
  contentType: string,
  base64Data: string
): Promise<boolean> {
  if (token.isMicrosoft) {
    return addAttachmentToMsgraphDraft(token, draftId, filename, contentType, base64Data);
  } else {
    return addAttachmentToGmailDraft(token, draftId, filename, contentType, base64Data);
  }
}

// ============================================================================
// Direct Calendar API Functions
// ============================================================================

const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

/**
 * Calendar event for direct API operations.
 */
export interface CalendarEventDirect {
  id: string;
  calendarId: string;
  summary: string;
  description?: string;
  start: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: "needsAction" | "accepted" | "declined" | "tentative";
    organizer?: boolean;
    self?: boolean;
  }>;
  recurrence?: string[];
  recurringEventId?: string;
  htmlLink?: string;
  conferenceData?: Record<string, unknown>;
  status?: "confirmed" | "tentative" | "cancelled";
  visibility?: "default" | "public" | "private";
  allDay?: boolean;
  isOrganizer?: boolean;
  provider?: "google" | "microsoft";
  location?: string;
}

/**
 * Input for creating a calendar event.
 */
export interface CreateCalendarEventInput {
  calendarId?: string;
  summary: string;
  description?: string;
  start: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  attendees?: Array<{ email: string; displayName?: string }>;
  recurrence?: string[];
  location?: string;
}

/**
 * Input for updating a calendar event.
 */
export interface UpdateCalendarEventInput {
  summary?: string;
  description?: string;
  start?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  attendees?: Array<{ email: string; displayName?: string }>;
  recurrence?: string[];
  location?: string;
}

/**
 * Options for listing calendar events.
 */
export interface ListCalendarEventsOptions {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  limit?: number;
}

/**
 * Free/busy time slot.
 */
export interface FreeBusySlot {
  start: string;
  end: string;
}

/**
 * Make a fetch call to Google Calendar API.
 */
async function gcalFetch(
  token: string,
  path: string,
  options?: RequestInit
): Promise<any | null> {
  const url = `${GOOGLE_CALENDAR_API_BASE}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    return null;
  }

  if (response.status === 204) {
    // No content (success for DELETE)
    return { success: true };
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Calendar API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.json();
}

/**
 * List calendar events directly via Google Calendar or MS Graph API.
 *
 * @param token - Token info
 * @param options - Filtering options (time range, limit)
 * @returns Array of calendar events
 */
export async function listCalendarEventsDirect(
  token: TokenInfo,
  options?: ListCalendarEventsOptions
): Promise<CalendarEventDirect[]> {
  const now = new Date();
  const timeMin = options?.timeMin || now.toISOString();
  const timeMax = options?.timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const limit = options?.limit || 50;

  if (token.isMicrosoft) {
    // MS Graph: Get calendar view
    let calendarId = options?.calendarId;

    // If no calendar ID, get the default calendar
    if (!calendarId) {
      const calendarsResult = await msgraphFetch(token.accessToken, "/me/calendars?$filter=isDefaultCalendar eq true");
      if (calendarsResult?.value?.[0]?.id) {
        calendarId = calendarsResult.value[0].id;
      } else {
        // Fallback to primary calendar
        const primaryResult = await msgraphFetch(token.accessToken, "/me/calendar");
        calendarId = primaryResult?.id;
      }
    }

    if (!calendarId) {
      return [];
    }

    const path = `/me/calendars/${calendarId}/calendarView?startDateTime=${encodeURIComponent(timeMin)}&endDateTime=${encodeURIComponent(timeMax)}&$top=${limit}&$orderby=start/dateTime`;
    const result = await msgraphFetch(token.accessToken, path);

    if (!result || !result.value) {
      return [];
    }

    return result.value.map((e: any) => ({
      id: e.id,
      calendarId: calendarId,
      summary: e.subject || "",
      description: e.bodyPreview || e.body?.content || "",
      start: {
        dateTime: e.start?.dateTime,
        timeZone: e.start?.timeZone,
        date: e.isAllDay ? e.start?.dateTime?.split("T")[0] : undefined,
      },
      end: {
        dateTime: e.end?.dateTime,
        timeZone: e.end?.timeZone,
        date: e.isAllDay ? e.end?.dateTime?.split("T")[0] : undefined,
      },
      attendees: (e.attendees || []).map((a: any) => ({
        email: a.emailAddress?.address || "",
        displayName: a.emailAddress?.name || "",
        responseStatus: mapMsResponseStatus(a.status?.response),
        organizer: e.organizer?.emailAddress?.address === a.emailAddress?.address,
      })),
      recurrence: e.recurrence ? [JSON.stringify(e.recurrence)] : undefined,
      recurringEventId: e.seriesMasterId,
      htmlLink: e.webLink,
      conferenceData: e.onlineMeeting,
      status: e.isCancelled ? "cancelled" : "confirmed",
      allDay: e.isAllDay,
      isOrganizer: e.isOrganizer,
      provider: "microsoft",
      location: e.location?.displayName,
    }));
  } else {
    // Google Calendar: Get events list
    const calendarId = options?.calendarId || "primary";
    const path = `/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=${limit}&singleEvents=true&orderBy=startTime`;

    const result = await gcalFetch(token.accessToken, path);

    if (!result || !result.items) {
      return [];
    }

    return result.items.map((e: any) => ({
      id: e.id,
      calendarId: calendarId,
      summary: e.summary || "",
      description: e.description || "",
      start: {
        dateTime: e.start?.dateTime,
        date: e.start?.date,
        timeZone: e.start?.timeZone,
      },
      end: {
        dateTime: e.end?.dateTime,
        date: e.end?.date,
        timeZone: e.end?.timeZone,
      },
      attendees: (e.attendees || []).map((a: any) => ({
        email: a.email || "",
        displayName: a.displayName || "",
        responseStatus: a.responseStatus || "needsAction",
        organizer: a.organizer,
        self: a.self,
      })),
      recurrence: e.recurrence,
      recurringEventId: e.recurringEventId,
      htmlLink: e.htmlLink,
      conferenceData: e.conferenceData,
      status: e.status || "confirmed",
      visibility: e.visibility,
      allDay: !!e.start?.date,
      isOrganizer: e.organizer?.self,
      provider: "google",
      location: e.location,
    }));
  }
}

/**
 * Map MS Graph response status to our format.
 */
function mapMsResponseStatus(status?: string): "needsAction" | "accepted" | "declined" | "tentative" {
  switch (status) {
    case "accepted":
      return "accepted";
    case "declined":
      return "declined";
    case "tentativelyAccepted":
      return "tentative";
    default:
      return "needsAction";
  }
}

/**
 * Convert our date/time format to MS Graph format.
 * MS Graph requires dateTime even for all-day events.
 */
function toMsGraphDateTime(
  input: { dateTime?: string; date?: string; timeZone?: string },
  isEndTime: boolean = false
): { dateTime: string | undefined; timeZone: string } {
  const dateTime = input.dateTime ||
    (input.date ? `${input.date}T${isEndTime ? "23:59:59" : "00:00:00"}` : undefined);
  return {
    dateTime,
    timeZone: input.timeZone || "UTC",
  };
}

/**
 * Convert attendees to MS Graph format.
 */
function toMsGraphAttendees(
  attendees?: Array<{ email: string; displayName?: string }>
): Array<{ emailAddress: { address: string; name: string }; type: string }> {
  return (attendees || []).map((a) => ({
    emailAddress: { address: a.email, name: a.displayName || "" },
    type: "required",
  }));
}

/**
 * Create a calendar event directly via Google Calendar or MS Graph API.
 *
 * @param token - Token info
 * @param event - Event data to create
 * @returns Created event ID or null on failure
 */
export async function createCalendarEventDirect(
  token: TokenInfo,
  event: CreateCalendarEventInput
): Promise<{ eventId: string } | null> {
  if (token.isMicrosoft) {
    // MS Graph: Create event
    let calendarId = event.calendarId;

    // If no calendar ID, get the default calendar
    if (!calendarId) {
      const primaryResult = await msgraphFetch(token.accessToken, "/me/calendar");
      calendarId = primaryResult?.id;
    }

    if (!calendarId) {
      throw new Error("Could not determine calendar ID");
    }

    const msEvent = {
      subject: event.summary,
      body: event.description ? { contentType: "text", content: event.description } : undefined,
      start: toMsGraphDateTime(event.start, false),
      end: toMsGraphDateTime(event.end, true),
      attendees: toMsGraphAttendees(event.attendees),
      location: event.location ? { displayName: event.location } : undefined,
      isAllDay: !!event.start.date && !event.start.dateTime,
    };

    const path = `/me/calendars/${calendarId}/events`;
    const result = await msgraphFetch(token.accessToken, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msEvent),
    });

    if (!result || !result.id) {
      return null;
    }

    return { eventId: result.id };
  } else {
    // Google Calendar: Create event
    const calendarId = event.calendarId || "primary";

    const gcalEvent = {
      summary: event.summary,
      description: event.description,
      start: event.start,
      end: event.end,
      attendees: (event.attendees || []).map((a) => ({
        email: a.email,
        displayName: a.displayName,
      })),
      recurrence: event.recurrence,
      location: event.location,
    };

    const path = `/calendars/${encodeURIComponent(calendarId)}/events`;
    const result = await gcalFetch(token.accessToken, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gcalEvent),
    });

    if (!result || !result.id) {
      return null;
    }

    return { eventId: result.id };
  }
}

/**
 * Update a calendar event directly via Google Calendar or MS Graph API.
 *
 * @param token - Token info
 * @param eventId - The event ID to update
 * @param updates - Fields to update
 * @param calendarId - Optional calendar ID (required for Google Calendar)
 * @returns true on success
 */
export async function updateCalendarEventDirect(
  token: TokenInfo,
  eventId: string,
  updates: UpdateCalendarEventInput,
  calendarId?: string
): Promise<boolean> {
  if (token.isMicrosoft) {
    // MS Graph: Update event
    const msUpdates: Record<string, unknown> = {};

    if (updates.summary) msUpdates.subject = updates.summary;
    if (updates.description) msUpdates.body = { contentType: "text", content: updates.description };
    if (updates.start) msUpdates.start = toMsGraphDateTime(updates.start, false);
    if (updates.end) msUpdates.end = toMsGraphDateTime(updates.end, true);
    if (updates.attendees) msUpdates.attendees = toMsGraphAttendees(updates.attendees);
    if (updates.location) msUpdates.location = { displayName: updates.location };

    const path = `/me/events/${eventId}`;
    const result = await msgraphFetch(token.accessToken, path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msUpdates),
    });

    return result !== null;
  } else {
    // Google Calendar: Patch event - field names match directly
    const calId = calendarId || "primary";
    const path = `/calendars/${encodeURIComponent(calId)}/events/${eventId}`;
    const result = await gcalFetch(token.accessToken, path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });

    return result !== null;
  }
}

/**
 * Delete a calendar event directly via Google Calendar or MS Graph API.
 *
 * @param token - Token info
 * @param eventId - The event ID to delete
 * @param calendarId - Optional calendar ID (required for Google Calendar)
 * @returns true on success
 */
export async function deleteCalendarEventDirect(
  token: TokenInfo,
  eventId: string,
  calendarId?: string
): Promise<boolean> {
  if (token.isMicrosoft) {
    // MS Graph: Delete event
    const path = `/me/events/${eventId}`;
    const response = await fetch(`${MSGRAPH_API_BASE}${path}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
      },
    });

    // 204 No Content = success
    return response.status === 204 || response.ok;
  } else {
    // Google Calendar: Delete event
    const calId = calendarId || "primary";
    const path = `/calendars/${encodeURIComponent(calId)}/events/${eventId}`;
    const result = await gcalFetch(token.accessToken, path, {
      method: "DELETE",
    });

    return result !== null;
  }
}

/**
 * Get free/busy information directly via Google Calendar or MS Graph API.
 *
 * @param token - Token info
 * @param timeMin - Start of time range (ISO string)
 * @param timeMax - End of time range (ISO string)
 * @param calendarIds - Optional calendar IDs to check
 * @returns Array of busy time slots
 */
export async function getFreeBusyDirect(
  token: TokenInfo,
  timeMin: string,
  timeMax: string,
  calendarIds?: string[]
): Promise<FreeBusySlot[]> {
  if (token.isMicrosoft) {
    // MS Graph: Get schedule (free/busy)
    // If specific calendars requested, use getSchedule
    // Otherwise, just query the calendar view and derive busy times
    if (calendarIds && calendarIds.length > 0) {
      const body = {
        schedules: calendarIds,
        startTime: { dateTime: timeMin, timeZone: "UTC" },
        endTime: { dateTime: timeMax, timeZone: "UTC" },
      };

      const result = await msgraphFetch(token.accessToken, "/me/calendar/getSchedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!result || !result.value) {
        return [];
      }

      const busy: FreeBusySlot[] = [];
      for (const schedule of result.value) {
        for (const item of schedule.scheduleItems || []) {
          if (item.status !== "free") {
            busy.push({
              start: item.start?.dateTime || "",
              end: item.end?.dateTime || "",
            });
          }
        }
      }
      return busy;
    } else {
      // Fall back to calendar view
      const events = await listCalendarEventsDirect(token, { timeMin, timeMax });
      return events
        .filter((e) => e.status !== "cancelled")
        .map((e) => ({
          start: e.start.dateTime || e.start.date || "",
          end: e.end.dateTime || e.end.date || "",
        }));
    }
  } else {
    // Google Calendar: FreeBusy query
    const items = calendarIds
      ? calendarIds.map((id) => ({ id }))
      : [{ id: "primary" }];

    const body = {
      timeMin,
      timeMax,
      items,
    };

    const result = await gcalFetch(token.accessToken, "/freeBusy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!result || !result.calendars) {
      return [];
    }

    const busy: FreeBusySlot[] = [];
    for (const calId of Object.keys(result.calendars)) {
      for (const slot of result.calendars[calId].busy || []) {
        busy.push({
          start: slot.start,
          end: slot.end,
        });
      }
    }

    return busy;
  }
}

// ============================================================================
// Direct Send/Draft API Functions
// ============================================================================

/**
 * Options for building a MIME message
 */
export interface MimeMessageOptions {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  inReplyTo?: string;
  references?: string[];
}

/**
 * Build an RFC 2822 MIME message and return it base64url encoded.
 * This is the format required by Gmail API for sending/creating drafts.
 */
export function buildMimeMessage(options: MimeMessageOptions): string {
  const headers: string[] = [
    "MIME-Version: 1.0",
    `From: ${options.from}`,
    `To: ${options.to.join(", ")}`,
  ];

  if (options.cc && options.cc.length > 0) {
    headers.push(`Cc: ${options.cc.join(", ")}`);
  }

  if (options.bcc && options.bcc.length > 0) {
    headers.push(`Bcc: ${options.bcc.join(", ")}`);
  }

  headers.push(`Subject: ${options.subject}`);

  // Content type based on whether body is HTML
  if (options.isHtml !== false) {
    headers.push("Content-Type: text/html; charset=utf-8");
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8");
  }

  // Add threading headers for replies
  if (options.inReplyTo) {
    // Ensure Message-ID format with angle brackets
    const formattedReplyTo = options.inReplyTo.startsWith("<")
      ? options.inReplyTo
      : `<${options.inReplyTo}>`;
    headers.push(`In-Reply-To: ${formattedReplyTo}`);
  }

  if (options.references && options.references.length > 0) {
    // Format references with angle brackets if needed
    const formattedRefs = options.references
      .map((r) => (r.startsWith("<") ? r : `<${r}>`))
      .join(" ");
    headers.push(`References: ${formattedRefs}`);
  }

  // Add empty line separator and body
  headers.push("");
  headers.push(options.body);

  const rawEmail = headers.join("\r\n");

  // Base64url encode the email
  const base64Email = Buffer.from(rawEmail)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return base64Email;
}

/**
 * Options for sending/creating draft
 */
export interface SendEmailDirectOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
}

/**
 * Thread info for composing replies.
 */
export interface ThreadInfoDirect {
  messageId: string | null;  // Last message's Message-ID for In-Reply-To
  references: string[];      // Reference chain
  subject: string;
  from: string;
  to: string[];
  cc: string[];
}

/**
 * Get thread information for composing a reply via direct API.
 * Fetches the thread and extracts headers needed for proper threading.
 *
 * @param token - Token info
 * @param threadId - The thread ID to get info for
 * @returns Thread info or null if not found
 */
export async function getThreadInfoDirect(
  token: TokenInfo,
  threadId: string
): Promise<ThreadInfoDirect | null> {
  if (token.isMicrosoft) {
    // MS Graph: $filter on conversationId returns "InefficientFilter" / 400,
    // so fetch recent messages and filter client-side (same as getThreadMessages).
    const selectFields = "id,subject,from,toRecipients,ccRecipients,internetMessageHeaders,receivedDateTime,conversationId";
    const recentPath = `/me/messages?$select=${selectFields}&$top=50&$orderby=receivedDateTime desc`;
    const result = await msgraphFetch(token.accessToken, recentPath);

    if (!result || !result.value) {
      return null;
    }

    // Filter by conversationId client-side and get the latest message
    const matches = result.value.filter((m: any) => m.conversationId === threadId);
    if (matches.length === 0) {
      return null;
    }

    // Sort descending by date and take the latest
    matches.sort((a: any, b: any) =>
      new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime()
    );
    const lastMessage = matches[0];

    // Extract Message-ID from internet message headers
    let messageId: string | null = null;
    const references: string[] = [];

    if (lastMessage.internetMessageHeaders) {
      for (const header of lastMessage.internetMessageHeaders) {
        if (header.name.toLowerCase() === "message-id") {
          messageId = header.value;
        } else if (header.name.toLowerCase() === "references") {
          references.push(...header.value.split(/\s+/).filter(Boolean));
        }
      }
    }

    // Add the last message ID to references if available
    if (messageId && !references.includes(messageId)) {
      references.push(messageId);
    }

    return {
      messageId,
      references,
      subject: lastMessage.subject || "",
      from: lastMessage.from?.emailAddress?.address || "",
      to: (lastMessage.toRecipients || []).map((r: any) => r.emailAddress?.address || "").filter(Boolean),
      cc: (lastMessage.ccRecipients || []).map((r: any) => r.emailAddress?.address || "").filter(Boolean),
    };
  } else {
    // Gmail: Get thread with full format to access headers
    const path = `/threads/${threadId}?format=full`;
    const result = await gmailFetch(token.accessToken, path);

    if (!result || !result.messages || result.messages.length === 0) {
      return null;
    }

    // Get the last message
    const lastMessage = result.messages[result.messages.length - 1];
    const headers = lastMessage.payload?.headers || [];

    // Helper to get header value
    const getHeader = (name: string): string => {
      const header = headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase());
      return header?.value || "";
    };

    // Extract Message-ID and References
    const messageId = getHeader("Message-ID") || getHeader("Message-Id") || null;
    const referencesStr = getHeader("References");
    const references = referencesStr ? referencesStr.split(/\s+/).filter(Boolean) : [];

    // Add the last message ID to references if available
    if (messageId && !references.includes(messageId)) {
      references.push(messageId);
    }

    // Parse From header (format: "Name <email>" or just "email")
    const fromHeader = getHeader("From");
    const fromMatch = fromHeader.match(/<([^>]+)>/) || [null, fromHeader];
    const from = fromMatch[1] || fromHeader;

    // Parse To and Cc headers
    const parseRecipients = (header: string): string[] => {
      if (!header) return [];
      return header
        .split(",")
        .map((r) => {
          const match = r.match(/<([^>]+)>/) || [null, r.trim()];
          return match[1] || r.trim();
        })
        .filter(Boolean);
    };

    return {
      messageId,
      references,
      subject: getHeader("Subject"),
      from,
      to: parseRecipients(getHeader("To")),
      cc: parseRecipients(getHeader("Cc")),
    };
  }
}
/**
 * Draft message object returned from listDraftsDirect
 */
export interface DraftMessage {
  id: string;
  subject: string;
  from: string;
  to: string[];
  preview: string;
  timestamp: string;
}

/**
 * List draft messages via direct Gmail/MS Graph API.
 *
 * Fetches draft messages from the Drafts folder without using Superhuman's UI.
 *
 * @param token - Token info with accessToken and isMicrosoft flag
 * @param limit - Maximum results (default 50)
 * @param offset - Results offset for pagination (default 0)
 * @returns Array of DraftMessage objects
 */
export async function listDraftsDirect(
  token: TokenInfo,
  limit: number = 50,
  offset: number = 0
): Promise<DraftMessage[]> {
  if (token.isMicrosoft) {
    // MS Graph: GET /me/mailFolders('Drafts')/messages
    const path = `/me/mailFolders('Drafts')/messages?$top=${limit}&$skip=${offset}&$select=id,subject,from,toRecipients,bodyPreview,receivedDateTime&$orderby=receivedDateTime desc`;
    const result = await msgraphFetch(token.accessToken, path) as MSGraphMessagesResponse | null;

    if (!result || !result.value) {
      return [];
    }

    return result.value.map((message: any) => ({
      id: message.id,
      subject: message.subject || "(no subject)",
      from: message.from?.emailAddress?.address || "",
      to: (message.toRecipients || []).map((r: any) => r.emailAddress?.address || "").filter(Boolean),
      preview: message.bodyPreview || "",
      timestamp: message.receivedDateTime || new Date().toISOString(),
    }));
  } else {
    // Gmail: GET /drafts?includeSpamTrash=false
    // Gmail doesn't have offset directly, but we can use pagination with pageToken
    const pageToken = offset > 0 ? `&pageToken=${offset}` : "";
    const path = `/drafts?maxResults=${limit}${pageToken}`;
    const result = await gmailFetch(token.accessToken, path) as GmailMessagesListResponse | null;

    if (!result || !result.messages || result.messages.length === 0) {
      return [];
    }

    const drafts: DraftMessage[] = [];

    // For each draft message ID, fetch its details
    for (const draft of result.messages) {
      try {
        const detailPath = `/drafts/${draft.id}?format=full`;
        const detailResult = await gmailFetch(token.accessToken, detailPath);

        if (!detailResult || !detailResult.message) {
          continue;
        }

        const message = detailResult.message;
        const payload = message.payload || {};
        const headers = payload.headers || [];

        // Helper to get header value
        const getHeader = (name: string) =>
          headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

        // Parse From header (format: "Name <email>" or just "email")
        const fromHeader = getHeader("From");
        const fromMatch = fromHeader.match(/<([^>]+)>/) || [null, fromHeader];
        const from = fromMatch[1] || fromHeader;

        // Parse To header
        const parseRecipients = (header: string): string[] => {
          if (!header) return [];
          return header
            .split(",")
            .map((r) => {
              const match = r.match(/<([^>]+)>/) || [null, r.trim()];
              return match[1] || r.trim();
            })
            .filter(Boolean);
        };

        const to = parseRecipients(getHeader("To"));

        // Extract body preview
        let preview = "";
        function extractPreview(part: any): void {
          if (part.body?.data) {
            const content = Buffer.from(part.body.data, "base64url").toString("utf-8");
            preview = content.substring(0, 200); // First 200 chars
          } else if (part.parts) {
            for (const p of part.parts) {
              if (!preview) {
                extractPreview(p);
              }
            }
          }
        }
        extractPreview(payload);

        // Use snippet as fallback for preview
        if (!preview && message.snippet) {
          preview = message.snippet;
        }

        // Get timestamp
        const dateHeader = getHeader("Date");
        const timestamp = dateHeader || new Date(parseInt(message.internalDate || "0")).toISOString();

        drafts.push({
          id: message.id,
          subject: getHeader("Subject") || "(no subject)",
          from,
          to,
          preview,
          timestamp,
        });
      } catch (error) {
        // Log error but continue processing other drafts
        console.error(`Error fetching draft ${draft.id}:`, error);
        continue;
      }
    }

    return drafts;
  }
}

/**
 * Create a draft via direct Gmail/MS Graph API.
 *
 * @param token - Token info
 * @param options - Email options
 * @returns Draft ID or null on failure
 */
export async function createDraftDirect(
  token: TokenInfo,
  options: SendEmailDirectOptions
): Promise<{ draftId: string; messageId?: string } | null> {
  if (token.isMicrosoft) {
    // MS Graph: POST /me/messages (creates draft in Drafts folder)
    const message: Record<string, unknown> = {
      subject: options.subject,
      body: {
        contentType: options.isHtml !== false ? "HTML" : "Text",
        content: options.body,
      },
      toRecipients: options.to.map((email) => ({
        emailAddress: { address: email },
      })),
    };

    if (options.cc && options.cc.length > 0) {
      message.ccRecipients = options.cc.map((email) => ({
        emailAddress: { address: email },
      }));
    }

    if (options.bcc && options.bcc.length > 0) {
      message.bccRecipients = options.bcc.map((email) => ({
        emailAddress: { address: email },
      }));
    }

    // Note: MS Graph doesn't support custom In-Reply-To/References headers
    // Threading is handled by conversationId automatically

    const result = await msgraphFetch(token.accessToken, "/me/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    if (!result || !result.id) {
      return null;
    }

    return { draftId: result.id, messageId: result.id };
  } else {
    // Gmail: POST /drafts with raw MIME message
    const mimeMessage = buildMimeMessage({
      from: token.email,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: options.body,
      isHtml: options.isHtml,
      inReplyTo: options.inReplyTo,
      references: options.references,
    });

    const payload: Record<string, unknown> = {
      message: { raw: mimeMessage },
    };

    if (options.threadId) {
      (payload.message as Record<string, unknown>).threadId = options.threadId;
    }

    const result = await gmailFetch(token.accessToken, "/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!result || !result.id) {
      return null;
    }

    return { draftId: result.id, messageId: result.message?.id };
  }
}

/**
 * Send an email via direct Gmail/MS Graph API.
 *
 * @param token - Token info
 * @param options - Email options
 * @returns Message ID or null on failure
 */
export async function sendEmailDirect(
  token: TokenInfo,
  options: SendEmailDirectOptions
): Promise<{ messageId: string; threadId?: string } | null> {
  if (token.isMicrosoft) {
    // MS Graph: POST /me/sendMail
    const message: Record<string, unknown> = {
      subject: options.subject,
      body: {
        contentType: options.isHtml !== false ? "HTML" : "Text",
        content: options.body,
      },
      toRecipients: options.to.map((email) => ({
        emailAddress: { address: email },
      })),
    };

    if (options.cc && options.cc.length > 0) {
      message.ccRecipients = options.cc.map((email) => ({
        emailAddress: { address: email },
      }));
    }

    if (options.bcc && options.bcc.length > 0) {
      message.bccRecipients = options.bcc.map((email) => ({
        emailAddress: { address: email },
      }));
    }

    const response = await fetch(`${MSGRAPH_API_BASE}/me/sendMail`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });

    // sendMail returns 202 Accepted with no body on success
    if (response.status === 202 || response.ok) {
      return { messageId: "sent", threadId: options.threadId };
    }

    return null;
  } else {
    // Gmail: POST /messages/send with raw MIME message
    const mimeMessage = buildMimeMessage({
      from: token.email,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: options.body,
      isHtml: options.isHtml,
      inReplyTo: options.inReplyTo,
      references: options.references,
    });

    const payload: Record<string, unknown> = { raw: mimeMessage };

    if (options.threadId) {
      payload.threadId = options.threadId;
    }

    const result = await gmailFetch(token.accessToken, "/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!result || !result.id) {
      return null;
    }

    return { messageId: result.id, threadId: result.threadId };
  }
}

/**
 * Create a reply draft via direct API.
 * Fetches thread info and creates a properly threaded draft.
 *
 * @param token - Token info
 * @param threadId - Thread to reply to
 * @param body - Reply body
 * @param options - Additional options
 * @returns Draft ID or null on failure
 */
export async function createReplyDraftDirect(
  token: TokenInfo,
  threadId: string,
  body: string,
  options?: {
    replyAll?: boolean;
    cc?: string[];
    bcc?: string[];
    isHtml?: boolean;
  }
): Promise<{ draftId: string; messageId?: string } | null> {
  if (token.isMicrosoft) {
    // MS Graph: Use createReply/createReplyAll endpoint
    // First, get the last message ID in the conversation
    const messagesPath = `/me/messages?$filter=conversationId eq '${threadId}'&$select=id&$orderby=receivedDateTime desc&$top=1`;
    const messagesResult = await msgraphFetch(token.accessToken, messagesPath);

    if (!messagesResult || !messagesResult.value || messagesResult.value.length === 0) {
      return null;
    }

    const lastMessageId = messagesResult.value[0].id;
    const endpoint = options?.replyAll ? "createReplyAll" : "createReply";

    // Create reply draft
    const createPath = `/me/messages/${lastMessageId}/${endpoint}`;
    const draftResult = await msgraphFetch(token.accessToken, createPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!draftResult || !draftResult.id) {
      return null;
    }

    // Update the draft with our body
    const patchBody: Record<string, unknown> = {
      body: {
        contentType: options?.isHtml !== false ? "HTML" : "Text",
        content: body,
      },
    };

    if (options?.cc && options.cc.length > 0) {
      patchBody.ccRecipients = options.cc.map((email) => ({
        emailAddress: { address: email },
      }));
    }

    if (options?.bcc && options.bcc.length > 0) {
      patchBody.bccRecipients = options.bcc.map((email) => ({
        emailAddress: { address: email },
      }));
    }

    await msgraphFetch(token.accessToken, `/me/messages/${draftResult.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patchBody),
    });

    return { draftId: draftResult.id, messageId: draftResult.id };
  } else {
    // Gmail: Get thread info and create draft with threading headers
    const threadInfo = await getThreadInfoDirect(token, threadId);
    if (!threadInfo) {
      return null;
    }

    // Build recipient list
    const to: string[] = [];
    const cc: string[] = options?.cc || [];

    if (options?.replyAll) {
      // Include original sender plus all To/Cc (excluding self)
      if (threadInfo.from && threadInfo.from !== token.email) {
        to.push(threadInfo.from);
      }
      for (const email of threadInfo.to) {
        if (email !== token.email && !to.includes(email)) {
          to.push(email);
        }
      }
      for (const email of threadInfo.cc) {
        if (email !== token.email && !cc.includes(email)) {
          cc.push(email);
        }
      }
    } else {
      // Simple reply to sender
      if (threadInfo.from) {
        to.push(threadInfo.from);
      }
    }

    if (to.length === 0) {
      return null;
    }

    // Build subject with Re: prefix
    const subject = threadInfo.subject.startsWith("Re:")
      ? threadInfo.subject
      : `Re: ${threadInfo.subject}`;

    return createDraftDirect(token, {
      to,
      cc,
      bcc: options?.bcc,
      subject,
      body,
      isHtml: options?.isHtml,
      threadId,
      inReplyTo: threadInfo.messageId || undefined,
      references: threadInfo.references,
    });
  }
}

/**
 * Send a reply via direct API.
 * Fetches thread info and sends a properly threaded reply.
 *
 * @param token - Token info
 * @param threadId - Thread to reply to
 * @param body - Reply body
 * @param options - Additional options
 * @returns Message ID or null on failure
 */
export async function sendReplyDirect(
  token: TokenInfo,
  threadId: string,
  body: string,
  options?: {
    replyAll?: boolean;
    cc?: string[];
    bcc?: string[];
    isHtml?: boolean;
  }
): Promise<{ messageId: string; threadId?: string } | null> {
  if (token.isMicrosoft) {
    // MS Graph: Create reply draft then send it
    const draftResult = await createReplyDraftDirect(token, threadId, body, options);
    if (!draftResult) {
      return null;
    }

    // Send the draft
    const sendPath = `/me/messages/${draftResult.draftId}/send`;
    const response = await fetch(`${MSGRAPH_API_BASE}${sendPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 202 || response.ok) {
      return { messageId: draftResult.draftId, threadId };
    }

    return null;
  } else {
    // Gmail: Get thread info and send with threading headers
    const threadInfo = await getThreadInfoDirect(token, threadId);
    if (!threadInfo) {
      return null;
    }

    // Build recipient list (same logic as createReplyDraftDirect)
    const to: string[] = [];
    const cc: string[] = options?.cc || [];

    if (options?.replyAll) {
      if (threadInfo.from && threadInfo.from !== token.email) {
        to.push(threadInfo.from);
      }
      for (const email of threadInfo.to) {
        if (email !== token.email && !to.includes(email)) {
          to.push(email);
        }
      }
      for (const email of threadInfo.cc) {
        if (email !== token.email && !cc.includes(email)) {
          cc.push(email);
        }
      }
    } else {
      if (threadInfo.from) {
        to.push(threadInfo.from);
      }
    }

    if (to.length === 0) {
      return null;
    }

    const subject = threadInfo.subject.startsWith("Re:")
      ? threadInfo.subject
      : `Re: ${threadInfo.subject}`;

    return sendEmailDirect(token, {
      to,
      cc,
      bcc: options?.bcc,
      subject,
      body,
      isHtml: options?.isHtml,
      threadId,
      inReplyTo: threadInfo.messageId || undefined,
      references: threadInfo.references,
    });
  }
}

/**
 * Update an existing draft via direct Gmail/MS Graph API.
 *
 * @param token - Token info
 * @param draftId - Draft ID to update
 * @param options - Fields to update (only provided fields are changed)
 * @returns Updated draft info or null on failure
 */
export async function updateDraftDirect(
  token: TokenInfo,
  draftId: string,
  options: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
    isHtml?: boolean;
  }
): Promise<{ draftId: string; messageId?: string } | null> {
  if (token.isMicrosoft) {
    // MS Graph: PATCH /me/messages/{id}
    const updates: Record<string, unknown> = {};

    if (options.subject !== undefined) {
      updates.subject = options.subject;
    }
    if (options.body !== undefined) {
      updates.body = {
        contentType: (options.isHtml ?? true) ? "HTML" : "Text",
        content: options.body,
      };
    }
    if (options.to) {
      updates.toRecipients = options.to.map((email) => ({
        emailAddress: { address: email },
      }));
    }
    if (options.cc) {
      updates.ccRecipients = options.cc.map((email) => ({
        emailAddress: { address: email },
      }));
    }
    if (options.bcc) {
      updates.bccRecipients = options.bcc.map((email) => ({
        emailAddress: { address: email },
      }));
    }

    const result = await msgraphFetch(token.accessToken, `/me/messages/${draftId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });

    if (!result?.id) return null;
    return { draftId: result.id, messageId: result.id };
  } else {
    // Gmail: GET existing draft, merge updates, PUT back
    const existing = await gmailFetch(token.accessToken, `/drafts/${draftId}?format=full`);
    if (!existing?.message) return null;

    const existingHeaders = existing.message.payload?.headers || [];
    const getHeader = (name: string) =>
      existingHeaders.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

    const to = options.to || getHeader("To").split(",").map((s: string) => s.trim()).filter(Boolean);
    const cc = options.cc || getHeader("Cc").split(",").map((s: string) => s.trim()).filter(Boolean);
    const bcc = options.bcc || getHeader("Bcc").split(",").map((s: string) => s.trim()).filter(Boolean);
    const subject = options.subject ?? getHeader("Subject");

    // Extract existing body if not being replaced
    let body = options.body;
    let isHtml = options.isHtml ?? true;
    if (body === undefined) {
      const payload = existing.message.payload;
      const extractBody = (part: any): string | undefined => {
        if (part.mimeType === "text/html" && part.body?.data) {
          isHtml = true;
          return Buffer.from(part.body.data, "base64url").toString("utf-8");
        }
        if (part.mimeType === "text/plain" && part.body?.data) {
          return Buffer.from(part.body.data, "base64url").toString("utf-8");
        }
        if (part.parts) {
          for (const p of part.parts) {
            const result = extractBody(p);
            if (result) return result;
          }
        }
        return undefined;
      };
      body = extractBody(payload) || "";
    }

    const mimeMessage = buildMimeMessage({
      from: token.email,
      to,
      cc: cc.length > 0 ? cc : undefined,
      bcc: bcc.length > 0 ? bcc : undefined,
      subject,
      body: body || "",
      isHtml,
      inReplyTo: getHeader("In-Reply-To") || undefined,
      references: getHeader("References") ? getHeader("References").split(/\s+/).filter(Boolean) : undefined,
    });

    const payload: Record<string, unknown> = {
      message: { raw: mimeMessage },
    };
    if (existing.message.threadId) {
      (payload.message as Record<string, unknown>).threadId = existing.message.threadId;
    }

    const result = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/drafts/${draftId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!result.ok) return null;
    const data = await result.json() as any;
    return { draftId: data.id, messageId: data.message?.id };
  }
}

/**
 * Delete a draft via direct API.
 *
 * @param token - Token info
 * @param draftId - Draft ID to delete
 * @returns true on success
 */
export async function deleteDraftDirect(
  token: TokenInfo,
  draftId: string
): Promise<boolean> {
  if (token.isMicrosoft) {
    // MS Graph: DELETE /me/messages/{id}
    const response = await fetch(`${MSGRAPH_API_BASE}/me/messages/${draftId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
      },
    });

    return response.status === 204 || response.ok;
  } else {
    // Gmail: DELETE /drafts/{id}
    const response = await fetch(`${GMAIL_API_BASE}/drafts/${draftId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
      },
    });

    return response.status === 204 || response.ok;
  }
}

/**
 * Send an existing draft by ID via direct API.
 *
 * @param token - Token info
 * @param draftId - Draft ID to send
 * @returns Message ID or null on failure
 */
export async function sendDraftDirect(
  token: TokenInfo,
  draftId: string
): Promise<{ messageId: string; threadId?: string } | null> {
  if (token.isMicrosoft) {
    // MS Graph: POST /me/messages/{id}/send
    const response = await fetch(`${MSGRAPH_API_BASE}/me/messages/${draftId}/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 202 || response.ok) {
      return { messageId: draftId };
    }

    return null;
  } else {
    // Gmail: POST /drafts/send with draft ID
    // Note: Gmail uses a different endpoint pattern
    const result = await gmailFetch(token.accessToken, `/drafts/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: draftId }),
    });

    if (!result || !result.id) {
      return null;
    }

    return { messageId: result.id, threadId: result.threadId };
  }
}

// ============================================================================
// Superhuman Backend API Functions
// ============================================================================

const SUPERHUMAN_BACKEND_BASE = "https://mail.superhuman.com/~backend";

/**
 * Superhuman backend token info.
 */
export interface SuperhumanTokenInfo {
  token: string;           // Backend auth token
  email: string;
  accountId?: string;
  expires?: number;
}

// In-memory cache for Superhuman tokens
const superhumanTokenCache = new Map<string, SuperhumanTokenInfo>();

/**
 * Extract Superhuman backend token via CDP.
 * The token is stored in window.GoogleAccount.backend._credential
 *
 * @param conn - Superhuman connection
 * @param email - Account email
 * @returns Superhuman token info
 */
export async function extractSuperhumanToken(
  conn: SuperhumanConnection,
  email: string
): Promise<SuperhumanTokenInfo> {
  const { Runtime } = conn;

  // Verify account exists and switch to it
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

  // Extract backend token (idToken is used for Superhuman backend API)
  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const ga = window.GoogleAccount;
          const credential = ga?.credential;

          if (!credential) {
            return { error: "Credential not found" };
          }

          // The Superhuman backend uses idToken (JWT), not accessToken (OAuth)
          const authData = credential._authData;
          if (!authData) {
            return { error: "AuthData not found" };
          }

          // idToken is the Firebase/Google Identity token used for Superhuman backend
          if (authData.idToken) {
            return {
              token: authData.idToken,
              email: ga?.emailAddress || authData.emailAddress || '',
              accountId: ga?.accountId,
              expires: authData.expires
            };
          }

          return { error: "Could not extract idToken" };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
  });

  const value = result.result.value as SuperhumanTokenInfo | { error: string };

  if ("error" in value) {
    throw new Error(`Superhuman token extraction failed: ${value.error}`);
  }

  return value;
}

/**
 * Get Superhuman backend token for an account, using cache if available.
 *
 * @param conn - Superhuman connection
 * @param email - Account email
 * @returns Superhuman token info
 */
export async function getSuperhumanToken(
  conn: SuperhumanConnection,
  email: string
): Promise<SuperhumanTokenInfo> {
  // Check cache first
  const cached = superhumanTokenCache.get(email);

  if (cached) {
    // Check if token is expired (if we have expiry info)
    if (cached.expires) {
      const bufferMs = 5 * 60 * 1000; // 5 minutes
      if (cached.expires < Date.now() + bufferMs) {
        // Expired, fall through to extract fresh
      } else {
        return cached;
      }
    } else {
      // No expiry info, assume valid
      return cached;
    }
  }

  // Extract fresh token
  const token = await extractSuperhumanToken(conn, email);

  // Cache it
  superhumanTokenCache.set(email, token);

  return token;
}

/**
 * Clear the Superhuman token cache.
 */
export function clearSuperhumanTokenCache(): void {
  superhumanTokenCache.clear();
}

/**
 * Make a fetch call to Superhuman backend API.
 *
 * @param token - Superhuman backend token
 * @param path - API path (e.g., "/v3/reminders/create")
 * @param options - Additional fetch options
 * @returns Response JSON or null on auth failure
 */
export async function superhumanFetch(
  token: string,
  path: string,
  options?: RequestInit
): Promise<any | null> {
  const url = `${SUPERHUMAN_BACKEND_BASE}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (response.status === 401 || response.status === 403) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`Superhuman API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  // Some endpoints return empty response
  const text = await response.text();
  if (!text) {
    return { success: true };
  }

  return JSON.parse(text);
}

// ============================================================================
// Superhuman AI API Functions
// ============================================================================

/**
 * Chat message for AI conversation history.
 */
export interface AIChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Full thread message with all metadata.
 * Note: The AI API (ai.compose) only accepts message_id, subject, body —
 * additional fields cause 400 errors, so callers must map accordingly.
 */
export interface FullThreadMessage {
  message_id: string;
  subject: string;
  body: string;
  from: { email: string; name: string };
  to: Array<{ email: string; name: string }>;
  cc: Array<{ email: string; name: string }>;
  date: string;
  snippet: string;
}

/**
 * Options for AI query.
 */
export interface AIQueryOptions {
  sessionId?: string;
  chatHistory?: AIChatMessage[];
  userName?: string;
  userEmail?: string;
  userCompany?: string;
  userPosition?: string;
  /**
   * The user's ShortId prefix (4 chars like "4sKP").
   * Required for generating valid event IDs.
   * Extract using extractUserPrefix() from a Superhuman connection.
   */
  userPrefix?: string;
}

/**
 * AI query result.
 */
export interface AIQueryResult {
  response: string;
  sessionId: string;
}

/**
 * Base62 charset used for Superhuman IDs.
 */
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate random characters from Base62 charset.
 */
function randomBase62(length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += BASE62.charAt(Math.floor(Math.random() * BASE62.length));
  }
  return result;
}

/**
 * Generate a unique event ID in Superhuman's format.
 *
 * Superhuman event IDs follow this structure (18 chars after prefix):
 * - Position 0-2: "11V" format prefix
 * - Position 3-6: 4 random chars (timestamp-like)
 * - Position 7-10: User prefix (e.g., "4sKP") - identifies the user
 * - Position 11-17: 7 random chars
 *
 * @param userPrefix - The 4-character user prefix extracted from Superhuman
 * @returns A properly formatted event ID like "event_11VXxxx4sKPxxxxxxx"
 */
function generateEventId(userPrefix: string = ""): string {
  // If no user prefix provided, fall back to old random generation
  if (!userPrefix || userPrefix.length !== 4) {
    let id = "event_";
    for (let i = 0; i < 18; i++) {
      id += BASE62.charAt(Math.floor(Math.random() * BASE62.length));
    }
    return id;
  }

  // Format: 11V + 4 random + userPrefix + 7 random = 18 chars total
  const formatPrefix = "11V";
  const midSection = randomBase62(4);
  const randomSuffix = randomBase62(7);

  return `event_${formatPrefix}${midSection}${userPrefix}${randomSuffix}`;
}

/**
 * Extract the user's ShortId prefix from Superhuman.
 *
 * The prefix is embedded in the userId stored in labels settings.
 * Format: user_XXXXXXX[4-char-prefix]XXXXXXX
 * The 4-char prefix is at positions 7-10 of the userId suffix.
 *
 * @param conn - Superhuman connection
 * @returns The 4-character user prefix (e.g., "4sKP"), or null if not found
 */
export async function extractUserPrefix(
  conn: { Runtime: { evaluate: (opts: { expression: string; returnByValue: boolean }) => Promise<{ result: { value: any } }> } }
): Promise<string | null> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const userId = ga?.labels?._settings?._cache?.userId;
        if (!userId) return null;
        const suffix = userId.replace('user_', '');
        // The user prefix is at positions 7-10 of the suffix
        if (suffix.length < 11) return null;
        return suffix.substring(7, 11);
      })()
    `,
    returnByValue: true,
  });

  return result.result.value || null;
}

/**
 * Parse an email address string like "Name <email>" or just "email".
 */
function parseEmailAddress(raw: string): { email: string; name: string } {
  const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ""), email: match[2] };
  }
  return { name: "", email: raw.trim() };
}

/**
 * Parse a comma-separated list of email addresses from a header value.
 */
function parseRecipientList(header: string): Array<{ email: string; name: string }> {
  if (!header) return [];
  return header.split(",").map((r) => parseEmailAddress(r.trim())).filter((r) => r.email);
}

/**
 * Map an MS Graph emailAddress object to { email, name }.
 */
function mapMsGraphContact(contact: any): { email: string; name: string } {
  return {
    email: contact?.emailAddress?.address || "",
    name: contact?.emailAddress?.name || "",
  };
}

/**
 * Map an array of MS Graph recipient objects to { email, name }[].
 */
function mapMsGraphContacts(recipients: any[] | undefined): Array<{ email: string; name: string }> {
  return (recipients || []).map(mapMsGraphContact);
}

/**
 * Get full thread messages with all metadata.
 * Fetches complete thread content including body text, headers, and recipients.
 *
 * @param token - OAuth token info
 * @param threadId - Thread ID to get messages from
 * @returns Array of full thread messages
 */
export async function getThreadMessages(
  token: TokenInfo,
  threadId: string
): Promise<FullThreadMessage[]> {
  if (token.isMicrosoft) {
    return getThreadMessagesMsGraph(token, threadId);
  }
  return getThreadMessagesGmail(token, threadId);
}

async function getThreadMessagesMsGraph(
  token: TokenInfo,
  threadId: string
): Promise<FullThreadMessage[]> {
  // The $filter on conversationId at /me/messages level returns "InefficientFilter",
  // so we fetch recent messages and filter client-side by conversationId.
  const selectFields = "id,subject,body,conversationId,receivedDateTime,from,toRecipients,ccRecipients,bodyPreview";
  const recentPath = `/me/messages?$select=${selectFields}&$top=50&$orderby=receivedDateTime desc`;
  const recentResult = await msgraphFetch(token.accessToken, recentPath);

  let messages: any[] = [];
  if (recentResult?.value) {
    messages = recentResult.value.filter((m: any) => m.conversationId === threadId);
    // Sort oldest first for thread context
    messages.sort((a: any, b: any) =>
      new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime()
    );
  }

  // Fallback: if threadId is actually a message ID, fetch it directly
  if (messages.length === 0) {
    const fallbackFields = "id,subject,body,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview";
    try {
      const msg = await msgraphFetch(token.accessToken, `/me/messages/${threadId}?$select=${fallbackFields}`);
      if (msg) {
        messages = [msg];
      }
    } catch {
      // Not a message ID either
    }
  }

  return messages.map((msg: any) => ({
    message_id: msg.id,
    subject: msg.subject || "",
    body: msg.body?.content || "",
    from: mapMsGraphContact(msg.from),
    to: mapMsGraphContacts(msg.toRecipients),
    cc: mapMsGraphContacts(msg.ccRecipients),
    date: msg.receivedDateTime || "",
    snippet: msg.bodyPreview || "",
  }));
}

async function getThreadMessagesGmail(
  token: TokenInfo,
  threadId: string
): Promise<FullThreadMessage[]> {
  const result = await gmailFetch(token.accessToken, `/threads/${threadId}?format=full`);

  if (!result || !result.messages) {
    return [];
  }

  return result.messages.map((msg: any) => {
    const headers = msg.payload?.headers || [];
    const getHeader = (name: string): string => {
      const h = headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase());
      return h?.value || "";
    };

    // Extract body from MIME parts, preferring plain text over HTML
    let body = "";
    function extractBody(part: any): void {
      if (part.mimeType === "text/plain" && part.body?.data) {
        body = Buffer.from(part.body.data, "base64url").toString("utf-8");
      } else if (part.mimeType === "text/html" && part.body?.data && !body) {
        const htmlBody = Buffer.from(part.body.data, "base64url").toString("utf-8");
        body = htmlBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      }
      if (part.parts) {
        for (const p of part.parts) {
          extractBody(p);
        }
      }
    }
    extractBody(msg.payload);

    return {
      message_id: msg.id,
      subject: getHeader("Subject"),
      body: body || msg.snippet || "",
      from: parseEmailAddress(getHeader("From")),
      to: parseRecipientList(getHeader("To")),
      cc: parseRecipientList(getHeader("Cc")),
      date: getHeader("Date"),
      snippet: msg.snippet || "",
    };
  });
}

/**
 * Query Superhuman's AI assistant about an email thread.
 *
 * Uses the /v3/ai.compose endpoint (Superhuman's native AI compose API).
 * The AI can summarize threads, extract action items, draft replies, etc.
 *
 * @param superhumanToken - Superhuman backend token
 * @param oauthToken - OAuth token for fetching thread content
 * @param threadId - Thread ID to ask about
 * @param query - Question to ask the AI
 * @param options - Additional options
 * @returns AI response
 */
export async function askAI(
  superhumanToken: string,
  oauthToken: TokenInfo,
  threadId: string | undefined,
  query: string,
  options?: AIQueryOptions
): Promise<AIQueryResult> {
  const sessionId = options?.sessionId || crypto.randomUUID();

  let payload: Record<string, unknown>;

  if (threadId) {
    // Reply mode: fetch thread messages for context
    const fullMessages = await getThreadMessages(oauthToken, threadId);
    const threadMessages = fullMessages.map((m) => ({
      message_id: m.message_id,
      subject: m.subject,
      body: m.body,
    }));

    if (threadMessages.length === 0) {
      throw new Error(`Thread not found or has no messages: ${threadId}`);
    }

    // Build thread_content string from messages (what Superhuman passes to its backend)
    const threadContent = threadMessages.map(m =>
      `Subject: ${m.subject}\n\n${m.body}`
    ).join("\n\n---\n\n");

    const lastMessage = threadMessages[threadMessages.length - 1];

    payload = {
      instructions: query,
      draft_content: "",
      draft_content_type: "text/html",
      draft_action: "reply",
      thread_content: threadContent,
      subject: threadMessages[0]?.subject || "",
      to: [],
      cc: [],
      bcc: [],
      thread_id: threadId,
      last_message_id: lastMessage.message_id,
    };
  } else {
    // Compose mode: no thread context needed
    payload = {
      instructions: query,
      draft_content: "",
      draft_content_type: "text/html",
      draft_action: "compose",
      thread_content: "",
      subject: "",
      to: [],
      cc: [],
      bcc: [],
      thread_id: "",
      last_message_id: "",
    };
  }

  const url = `${SUPERHUMAN_BACKEND_BASE}/v3/ai.compose`;

  const fetchResponse = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${superhumanToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (fetchResponse.status === 401 || fetchResponse.status === 403) {
    throw new Error("AI query failed - authentication error");
  }

  if (!fetchResponse.ok) {
    const errorText = await fetchResponse.text().catch(() => "Unknown error");
    throw new Error(`AI query failed: ${fetchResponse.status} ${fetchResponse.statusText} - ${errorText}`);
  }

  // Parse the streaming response (Server-Sent Events format)
  // ai.compose returns chunks like: data: {"choices":[{"delta":{"content":"text"}}]}
  const responseText = await fetchResponse.text();
  let fullContent = "";

  for (const line of responseText.split("\n")) {
    if (line.startsWith("data: ")) {
      const jsonStr = line.substring(6).trim();
      if (jsonStr === "[DONE]" || jsonStr === "END" || jsonStr === "") continue;

      try {
        const data = JSON.parse(jsonStr);
        // ai.compose format: choices[0].delta.content
        const delta = data?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") {
          fullContent += delta;
        }
        // Also handle legacy askAIProxy format (content at top level)
        if (data.content && !data.choices) {
          fullContent = data.content;
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  }

  return {
    response: fullContent || responseText,
    sessionId,
  };
}

/**
 * Decode a JWT token payload without verification.
 * Used to extract claims like `sub` (Google provider ID) from Superhuman's idToken.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return {};
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

/**
 * Format a FullThreadMessage for the askAIProxy API.
 * The proxy expects string-formatted from/to/cc/bcc fields, not objects.
 */
function formatMessageForAIProxy(m: FullThreadMessage): Record<string, unknown> {
  const formatContact = (c: { email: string; name: string }) =>
    c.name ? `${c.name} <${c.email}>` : c.email;
  const formatContacts = (contacts: Array<{ email: string; name: string }>) =>
    contacts.map(formatContact).join(", ");

  return {
    message_id: m.message_id,
    subject: m.subject,
    body: m.body,
    date: m.date,
    from: formatContact(m.from),
    to: formatContacts(m.to),
    cc: formatContacts(m.cc),
    bcc: "",
    links: [],
    attachment_names: [],
  };
}

/**
 * Query Superhuman's Ask AI search using the /v3/ai.askAIProxy endpoint.
 *
 * This is the full Ask AI feature — supports search, summarization, drafting, etc.
 * The AI decides what to do based on the query and available skills.
 *
 * @param superhumanToken - Superhuman backend token (idToken JWT)
 * @param oauthToken - OAuth token for the account
 * @param query - Natural language query
 * @param options - Additional options (threadId, session, user info)
 * @returns AI response with session info
 */
export async function askAISearch(
  superhumanToken: string,
  oauthToken: TokenInfo,
  query: string,
  options?: AIQueryOptions & { threadId?: string }
): Promise<AIQueryResult> {
  const sessionId = options?.sessionId || crypto.randomUUID();

  // Extract provider_id from the JWT idToken
  const jwtPayload = decodeJwtPayload(superhumanToken);
  const providerId = (jwtPayload.sub as string) || (jwtPayload.user_id as string) || "";

  // Use stored user prefix for event ID generation
  const userPrefix = options?.userPrefix || oauthToken.userPrefix || "";

  // Generate question event ID
  const questionEventId = generateEventId(userPrefix);

  // Build current_thread_messages if a thread is specified
  let currentThreadId = options?.threadId || "";
  let currentThreadMessages: Record<string, unknown>[] = [];

  if (currentThreadId) {
    try {
      const fullMessages = await getThreadMessages(oauthToken, currentThreadId);
      currentThreadMessages = fullMessages.map(formatMessageForAIProxy);
    } catch {
      // Thread fetch failed — continue without thread context
    }
  }

  // Get local datetime in ISO format with timezone offset
  const now = new Date();
  const tzOffset = -now.getTimezoneOffset();
  const tzSign = tzOffset >= 0 ? "+" : "-";
  const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, "0");
  const tzMins = String(Math.abs(tzOffset) % 60).padStart(2, "0");
  const localDatetime = now.toISOString().replace("Z", "").replace(/\.\d+$/, "") +
    `${tzSign}${tzHours}:${tzMins}`;

  const payload = {
    session_id: sessionId,
    question_event_id: questionEventId,
    query,
    chat_history: options?.chatHistory?.map((m) => ({
      role: m.role,
      content: m.content,
    })) || [],
    user: {
      provider_id: providerId,
      email: options?.userEmail || oauthToken.email,
      name: options?.userName || "",
      company: options?.userCompany || "",
      position: options?.userPosition || "",
    },
    local_datetime: localDatetime,
    current_thread_id: currentThreadId,
    current_thread_messages: currentThreadMessages,
    available_skills: ["filter", "schedule", "multiMessage", "draft", "displayThoughts"],
  };

  const url = `${SUPERHUMAN_BACKEND_BASE}/v3/ai.askAIProxy`;

  const fetchResponse = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${superhumanToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (fetchResponse.status === 401 || fetchResponse.status === 403) {
    throw new Error("AI query failed - authentication error");
  }

  if (!fetchResponse.ok) {
    const errorText = await fetchResponse.text().catch(() => "Unknown error");
    throw new Error(`AI query failed: ${fetchResponse.status} ${fetchResponse.statusText} - ${errorText}`);
  }

  // Parse the SSE streaming response
  // askAIProxy returns cumulative content: each event has the full text up to that point
  const responseText = await fetchResponse.text();
  let fullContent = "";

  for (const line of responseText.split("\n")) {
    if (line.startsWith("data: ")) {
      const jsonStr = line.substring(6).trim();
      if (jsonStr === "[DONE]" || jsonStr === "END" || jsonStr === "") continue;

      try {
        const data = JSON.parse(jsonStr);
        // askAIProxy format: content at top level (cumulative)
        if (typeof data.content === "string") {
          fullContent = data.content;
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  }

  // Strip <thinking>...</thinking> tags from the response
  fullContent = fullContent.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim();

  return {
    response: fullContent || responseText,
    sessionId,
  };
}
