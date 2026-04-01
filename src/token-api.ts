/**
 * Token API Module
 *
 * Token extraction, caching, and Superhuman backend API functions.
 * Provider-specific OAuth/API code (Gmail, MS Graph) has been removed;
 * all email operations now go through Superhuman's backend API.
 */

import type { SuperhumanConnection, ChromeExtConnection } from "./superhuman-api";
import { connectToSuperhuman, getCDPPort, getCDPHost, disconnect } from "./superhuman-api";
import { listAccounts, switchAccount } from "./accounts";

/**
 * Full token info stored in the token cache.
 *
 * With the migration to SuperhumanProvider, the primary fields needed are:
 *   - email, superhumanToken (used by SuperhumanProvider / SuperhumanTokenInfo)
 *
 * The following fields are retained for backward compatibility with
 * CachedTokenProvider and legacy OAuth flows, but are candidates for
 * removal once all operations route through SuperhumanProvider:
 *   - accessToken (OAuth access token — replaced by superhumanToken.token)
 *   - expires (OAuth token expiry — replaced by superhumanToken.expires)
 *   - isMicrosoft (provider detection — SuperhumanProvider is provider-agnostic)
 *   - refreshToken (OAuth refresh — not needed for Superhuman JWT)
 *   - idToken / idTokenExpires (legacy Superhuman auth, superseded by superhumanToken)
 */
export interface TokenInfo {
  /** @deprecated Use superhumanToken.token instead when available */
  accessToken: string;
  email: string;
  /** @deprecated Use superhumanToken.expires instead when available */
  expires: number;
  /** @deprecated SuperhumanProvider is provider-agnostic; retained for CachedTokenProvider compat */
  isMicrosoft: boolean;
  /** @deprecated OAuth refresh token — not needed for Superhuman JWT flow */
  refreshToken?: string;
  // Superhuman backend API fields
  userId?: string;
  /** @deprecated Superseded by superhumanToken.token */
  idToken?: string;
  /** @deprecated Superseded by superhumanToken.expires */
  idTokenExpires?: number;
  // 4-char user prefix for generating event IDs (e.g., "4sKP")
  userPrefix?: string;
  /** Superhuman backend JWT — the primary token for all API operations */
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

  // Extract token via getIDTokenAsync() for a guaranteed fresh Firebase token
  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const ga = window.GoogleAccount;
          const cred = ga?.credential;
          const user = cred?.user;
          const di = ga?.di;

          // Get a fresh ID token via Firebase's internal refresh
          const idToken = await cred.getIDTokenAsync();
          const authData = cred?._authData;

          if (!idToken) {
            return { error: "getIDTokenAsync() returned null" };
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
            accessToken: authData?.accessToken || '',
            email: ga?.emailAddress || '',
            expires: authData?.expires || (Date.now() + 3600000),
            isMicrosoft: !!di?.get?.('isMicrosoft'),
            // Superhuman backend API fields
            userId: user?._id,
            idToken: idToken,
            idTokenExpires: authData?.expires || (Date.now() + 3600000),
            userPrefix: userPrefix,
          };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
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
 * Refresh a single account's token via CDP by calling Superhuman's
 * credential.getIDTokenAsync(), which uses Firebase's internal refresh
 * mechanism. Works for both Google and Microsoft accounts.
 *
 * Returns the updated TokenInfo, or undefined if refresh failed.
 */
async function refreshTokenViaCDP(email: string): Promise<TokenInfo | undefined> {
  let conn: SuperhumanConnection | null = null;
  try {
    conn = await connectToSuperhuman(getCDPPort(), false);
    if (!conn) return undefined;

    const token = await extractToken(conn, email);
    // Populate superhumanToken from idToken (extractToken only sets idToken)
    if (token.idToken) {
      token.superhumanToken = {
        token: token.idToken,
        expires: token.idTokenExpires ?? token.expires,
      };
    }
    // Update in-memory cache
    tokenCache.set(email, token);
    // Persist to disk
    await saveTokensToDisk();
    return token;
  } catch {
    return undefined;
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Get cached token for a specific account.
 *
 * If the token is expired or expiring soon, attempts on-demand refresh
 * via CDP before giving up.
 *
 * @param email - Account email
 * @returns Token info if valid, undefined otherwise
 */
export async function getCachedToken(email: string): Promise<TokenInfo | undefined> {
  const token = tokenCache.get(email);
  if (!token) return undefined;

  const bufferMs = 5 * 60 * 1000; // 5 minutes
  if (token.expires < Date.now() + bufferMs) {
    // Token expired or expiring soon — try on-demand refresh
    return await refreshTokenViaCDP(email);
  }

  return token;
}

/**
 * Get raw cached token without expiry check or refresh.
 * Used for reading metadata (e.g. isMicrosoft) without triggering CDP.
 */
export function getCachedTokenRaw(email: string): TokenInfo | undefined {
  return tokenCache.get(email);
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
      "Content-Type": "text/plain;charset=UTF-8",
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
// Superhuman Thread Info Helper
// ============================================================================

/**
 * Thread information needed for constructing replies/forwards.
 * Fetched via the Superhuman backend API (no provider OAuth needed).
 */
export interface ThreadInfoDirect {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  messageId: string | null;
  references: string[];
}

/**
 * Get thread info (subject, from, to, cc, messageId, references) from
 * the Superhuman backend API.
 *
 * Uses `userdata.getThreads` with a threadIds filter to fetch the thread,
 * then extracts the last message's metadata.
 *
 * @param token - TokenInfo with superhumanToken
 * @param threadId - Thread ID to fetch
 * @returns ThreadInfoDirect or null if not found
 */
export async function getThreadInfoSuperhuman(
  token: TokenInfo,
  threadId: string
): Promise<ThreadInfoDirect | null> {
  const authToken = token.superhumanToken?.token;
  if (!authToken) {
    return null;
  }

  try {
    const result = await superhumanFetch(authToken, "/v3/userdata.getThreads", {
      method: "POST",
      body: JSON.stringify({
        filter: { threadIds: [threadId] },
        offset: 0,
        limit: 1,
      }),
    });

    if (!result || !result.threadList || result.threadList.length === 0) {
      return null;
    }

    const threadData = result.threadList[0];
    const messages = threadData.thread?.messages || {};
    const messageEntries = Object.values(messages) as any[];

    if (messageEntries.length === 0) {
      return null;
    }

    // Get the last message (most recent) for reply metadata
    const lastMsg = messageEntries[messageEntries.length - 1];
    const msg = lastMsg.message || lastMsg.draft || lastMsg;

    return {
      subject: msg.subject || threadData.thread?.subject || "",
      from: msg.from || "",
      to: Array.isArray(msg.to) ? msg.to : msg.to ? [msg.to] : [],
      cc: Array.isArray(msg.cc) ? msg.cc : msg.cc ? [msg.cc] : [],
      messageId: msg.messageId || msg.rfc822Id || null,
      references: Array.isArray(msg.references) ? msg.references : [],
    };
  } catch (_e) {
    return null;
  }
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
 * @param query - Natural language query
 * @param options - Additional options (threadId, threadMessages, email, userPrefix, session, user info)
 * @returns AI response with session info
 */
export async function askAISearch(
  superhumanToken: string,
  query: string,
  options?: AIQueryOptions & {
    threadId?: string;
    threadMessages?: FullThreadMessage[];
    email?: string;
    userPrefix?: string;
  }
): Promise<AIQueryResult> {
  const sessionId = options?.sessionId || crypto.randomUUID();

  // Extract provider_id from the JWT idToken
  const jwtPayload = decodeJwtPayload(superhumanToken);
  const providerId = (jwtPayload.sub as string) || (jwtPayload.user_id as string) || "";

  // Use stored user prefix for event ID generation
  const userPrefix = options?.userPrefix || "";

  // Generate question event ID
  const questionEventId = generateEventId(userPrefix);

  // Build current_thread_messages if a thread is specified and messages are provided
  let currentThreadId = options?.threadId || "";
  let currentThreadMessages: Record<string, unknown>[] = [];

  if (currentThreadId && options?.threadMessages) {
    currentThreadMessages = options.threadMessages.map(formatMessageForAIProxy);
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
      email: options?.email || options?.userEmail || "",
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
      "Content-Type": "text/plain;charset=UTF-8",
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
