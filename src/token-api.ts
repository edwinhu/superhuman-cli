/**
 * Token API Module
 *
 * Token extraction, caching, and Superhuman backend API functions.
 * Provider-specific OAuth/API code (Gmail, MS Graph) has been removed;
 * all email operations now go through Superhuman's backend API.
 */

import type { SuperhumanConnection, ChromeExtConnection } from "./superhuman-api";
import { connectToSuperhuman, getCDPPort, getCDPHost, disconnect, discoverSuperhumanPort } from "./superhuman-api";
import { listAccounts, switchAccount } from "./accounts";
import {
  refreshAllViaBackgroundPage,
  refreshOneViaBackgroundPage,
} from "./background-page-refresh";
import {
  refreshViaSessionCookies,
  refreshManyViaSessionCookies,
} from "./session-refresh";

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
  /**
   * True when `accessToken` is an Outlook Web (OWA) first-party session token
   * (aud=outlook.office.com), brokered from the live OWA tab rather than issued
   * by Superhuman. Verbs branch on this to route to the Outlook REST backend
   * instead of MS Graph / the Superhuman backend. Always accompanies
   * `isMicrosoft: true`.
   */
  isOutlookWeb?: boolean;
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
  /** Full Superhuman external user ID, e.g. "user_11SzDPi4sKPTbHQRMQ" */
  userExternalId?: string;
  /** Stable device UUID for x-superhuman-device-id header */
  deviceId?: string;
  /** Superhuman backend JWT — the primary token for all API operations */
  superhumanToken?: {
    token: string;
    expires?: number;
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
          let userExternalId = null;
          try {
            const shUserId = ga?.labels?._settings?._cache?.userId;
            if (shUserId) {
              userExternalId = shUserId;
              const suffix = shUserId.replace('user_', '');
              if (suffix.length >= 11) {
                userPrefix = suffix.substring(7, 11);
              }
            }
          } catch (_) {}

          // Extract device ID
          let deviceId = null;
          try {
            deviceId = window.device?.id || ga?.device?.id || null;
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
            userExternalId: userExternalId,
            deviceId: deviceId,
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
        Buffer.from(t.token.split(".")[1]!, "base64url").toString()
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
 * Bound a service-worker Runtime.evaluate.
 *
 * MV3 service workers idle-stop after ~30s. A stopped worker still appears in
 * `CDP.List()` and still accepts a websocket connection, but never answers —
 * `Runtime.evaluate` hangs forever, not even `1+1` returns (verified
 * 2026-07-16; see docs/investigations/2026-07-16_attachment_download_401.md).
 * Without a timeout that hang propagates all the way up: `superhuman account
 * auth` would sit forever instead of falling through to a path that works.
 */
async function swEvaluateWithTimeout(
  swClient: ChromeExtConnection["swClient"],
  params: Parameters<ChromeExtConnection["swClient"]["Runtime"]["evaluate"]>[0],
  timeoutMs = SW_EVALUATE_TIMEOUT_MS
): Promise<Awaited<ReturnType<ChromeExtConnection["swClient"]["Runtime"]["evaluate"]>>> {
  const result = await Promise.race([
    swClient.Runtime.evaluate(params),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (result === null) {
    throw new Error(
      "Superhuman extension service worker did not respond " +
        `within ${timeoutMs}ms (likely idle-stopped)`
    );
  }
  return result;
}

const SW_EVALUATE_TIMEOUT_MS = 5000;

/**
 * Extract tokens for an account via Chrome extension CDP interception.
 *
 * Intercepts network requests from the service worker to capture:
 * 1. Superhuman backend token (Firebase JWT used for /~backend/ calls)
 * 2. Provider access token (Google/Microsoft OAuth token)
 *
 * NOTE: this depends on evaluating JS inside the extension's service worker,
 * which is unavailable whenever the worker is idle-stopped. Prefer
 * `refreshViaSessionCookies()` (session-refresh.ts), which needs no extension
 * context at all; this path remains as a fallback and now fails fast.
 */
export async function extractTokenChrome(
  conn: ChromeExtConnection,
  email: string
): Promise<TokenInfo> {
  const { swClient, mainClient } = conn;

  // 1. Read account metadata from service worker
  const meta = await swEvaluateWithTimeout(swClient, {
    expression: `(() => {
      const bg = backgrounds[${JSON.stringify(email)}]?._accountBackground;
      if (!bg) return null;
      let userPrefix = null;
      let userExternalId = null;
      try {
        const uid = bg.settings?._cache?.userId;
        if (uid) {
          userExternalId = uid;
          const s = uid.replace("user_", "");
          if (s.length >= 11) userPrefix = s.substring(7, 11);
        }
      } catch {}
      return {
        userId: bg.labels?._user?._id || null,
        provider: bg.provider || "google",
        userPrefix,
        userExternalId,
      };
    })()`,
    returnByValue: true,
  });

  const metadata = meta.result.value as {
    userId: string | null;
    provider: string;
    userPrefix: string | null;
    userExternalId: string | null;
  } | null;

  if (!metadata)
    throw new Error(`Account not found in Chrome extension: ${email}`);

  const isMicrosoft = metadata.provider === "microsoft";

  // 2. Refresh + read both tokens directly from the extension's in-memory
  //    Credential — no page navigation/reload, no Fetch interception, no
  //    hidden tab, no focus change.
  //
  //    The MV3 service worker holds an initialized `credential` component per
  //    account in its dependency injector. Its own public
  //    `getAuthDataInBackgroundAsync({ refresh: true })` runs Superhuman's
  //    `~backend/v3/sessions.getTokens` flow and returns fresh credentials in
  //    place. authData shape: { accessToken (provider OAuth), idToken
  //    (Superhuman backend JWT), expires (provider-token expiry, ms) }.
  //
  //    The previous implementation navigated + reloaded the user's live
  //    mail.superhuman.com tab TWICE (once per token class) and sniffed the
  //    tokens off the resulting network requests — which reloaded the user's
  //    window on every refresh and left Fetch handlers attached (the source of
  //    the post-refresh hang). Reading the Credential directly avoids both.
  const authEval = await swEvaluateWithTimeout(swClient, {
    expression: `(async () => {
      const bg = backgrounds[${JSON.stringify(email)}]?._accountBackground;
      if (!bg?.di?.isInitialized?.("credential"))
        throw new Error("credential component not initialized");
      const credential = bg.di.get("credential");
      const { authData } = await credential.getAuthDataInBackgroundAsync({ refresh: true });
      if (!authData?.accessToken || !authData?.idToken || !authData?.expires)
        throw new Error("incomplete in-memory auth data");
      return {
        accessToken: authData.accessToken,
        idToken: authData.idToken,
        expires: authData.expires,
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (authEval.exceptionDetails) {
    throw new Error(
      `In-memory token refresh failed for ${email}: ${
        authEval.exceptionDetails.exception?.description ??
        authEval.exceptionDetails.text ??
        "unknown error"
      }`
    );
  }

  const authData = authEval.result.value as {
    accessToken: string;
    idToken: string;
    expires: number;
  };

  // 3. Backend JWT (primary token for all API ops).
  const bestToken = authData.idToken;

  // 4. Provider OAuth access token + expiry. Prefer the Credential's own
  //    `expires`; if the token is a JWT (Microsoft), clamp to its `exp`.
  //    Google access tokens (ya29.*) are opaque, so the JSON.parse throws and
  //    we keep `authData.expires` — that's expected.
  const accessToken = authData.accessToken;
  let accessTokenExpires = authData.expires;
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1]!, "base64url").toString()
    );
    if (payload.exp) accessTokenExpires = payload.exp * 1000;
  } catch {}

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
              Buffer.from(bestToken.split(".")[1]!, "base64url").toString()
            );
            return p.exp ? p.exp * 1000 : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined,
    userPrefix: metadata.userPrefix ?? undefined,
    userExternalId: metadata.userExternalId ?? undefined,
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
  tokensLoaded = false;
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

let tokensLoaded = false;

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
      userExternalId?: string; // Full Superhuman external user ID
      deviceId?: string; // Stable device UUID for x-superhuman-device-id header
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
      userExternalId: token.userExternalId,
      // Keep existing deviceId if present, otherwise generate a stable UUID
      deviceId: token.deviceId || crypto.randomUUID(),
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
  if (tokensLoaded) return true;
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
        userExternalId: account.userExternalId,
        deviceId: account.deviceId,
        superhumanToken: account.superhumanToken, // Preserve full superhuman token
      });
    }

    tokensLoaded = true;
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
async function extractAndCache(conn: SuperhumanConnection, email: string): Promise<TokenInfo> {
  const token = await extractToken(conn, email);
  if (token.idToken) {
    token.superhumanToken = { token: token.idToken, expires: token.idTokenExpires ?? token.expires };
  }
  tokenCache.set(token.email, token);
  await saveTokensToDisk();
  return token;
}

/**
 * Refresh a single account's token.
 *
 * Preferred path: the Electron background_page iframe context — silent,
 * no UI navigation, no focus stealing. Tried first.
 *
 * Fallback: the legacy navigation-based path via the visible mail page.
 * Only invoked when the background_page target isn't reachable (e.g.
 * Superhuman.app not running with --remote-debugging-port). The
 * navigation path stays as a last resort because it brings the
 * Electron window to the foreground.
 *
 * Returns the updated TokenInfo, or undefined if refresh failed.
 */
export async function refreshTokenViaCDP(email: string): Promise<TokenInfo | undefined> {
  // Only attempt refresh if the account was previously cached.
  // Accounts that have never been authenticated cannot be refreshed —
  // the user must run 'superhuman account auth' first. This also
  // prevents hanging in test environments where CDP is reachable but
  // the test email doesn't exist in the Superhuman session.
  if (!tokenCache.has(email)) return undefined;

  // Resolve the port that actually hosts a Superhuman target. The desktop
  // app's background_page (needed below) often runs on a non-default port
  // (e.g. 9252), so we can't rely on the static getCDPPort() default.
  const port = await discoverSuperhumanPort();

  // ---- Preferred path: iframe context on background_page ----
  // No navigation, no focus stealing. Returns null if the bg page
  // isn't reachable or this email's iframe isn't loaded.
  try {
    const iframeRefreshed = await refreshOneViaBackgroundPage(email, port);
    if (iframeRefreshed) {
      tokenCache.set(iframeRefreshed.email, iframeRefreshed);
      await saveTokensToDisk();
      return iframeRefreshed;
    }
  } catch {
    // Fall through.
  }

  // ---- Superhuman-backend session refresh (works on Chrome-extension
  //      deployments, where there is no Electron background_page) ----
  // Mints fresh tokens via accounts.superhuman.com/~backend/v3/sessions.getTokens
  // using the browser's long-lived Superhuman session cookies — the same call
  // the app's own Credential.refreshSession() makes. Silent (cookie read +
  // HTTPS; no navigation, no focus steal) and provider-agnostic: the backend
  // returns the account's Google *or* Microsoft OAuth token.
  //
  // Without this, on a Chrome-extension deployment every refresh failed (the
  // extension's service-worker/offscreen targets don't answer CDP at all), so
  // callers used a stale token and live-API paths like `attachment download`
  // 401'd until a manual `superhuman account auth`.
  try {
    const sessionRefreshed = await refreshViaSessionCookies(
      email,
      tokenCache.get(email),
      port
    );
    if (sessionRefreshed) {
      tokenCache.set(sessionRefreshed.email, sessionRefreshed);
      await saveTokensToDisk();
      return sessionRefreshed;
    }
  } catch {
    // Fall through.
  }

  // ---- Opt-in auto-heal: rebind a dead CDP port, then retry silently ----
  // Superhuman's remote-debugging port can tear down mid-session; when it
  // does, the iframe path above fails on every refresh. With
  // SH_CDP_AUTOHEAL=1 the user permits a background quit+relaunch of the app
  // to restore the port. The relaunch stays hidden/background (`open -gja`)
  // so it never steals focus — unlike the legacy nav fallback below.
  // Default off, because it closes+reopens the app window.
  if (process.env.SH_CDP_AUTOHEAL === "1") {
    try {
      const { ensureCDPHealthy } = await import("./app-health");
      const health = await ensureCDPHealthy({ allowRelaunch: true });
      if (health.healthy) {
        const retried = await refreshOneViaBackgroundPage(email, getCDPPort());
        if (retried) {
          tokenCache.set(retried.email, retried);
          await saveTokensToDisk();
          return retried;
        }
      }
    } catch {
      // Fall through.
    }
  }

  // ---- Fallback: legacy navigation-based path ----
  // DISABLED BY DEFAULT. This path calls switchAccount() → Page.navigate()
  // on the *visible* mail.superhuman.com window, which brings the Electron
  // app to the foreground and steals focus. When the background_page target
  // is unreachable (e.g. Superhuman's CDP debug port has torn down mid-
  // session — see `superhuman doctor`), this path fired on nearly every
  // token refresh and caused recurring, unexpected focus grabs.
  //
  // Returning undefined here is safe: callers treat a failed refresh as
  // "use the stale token" (getCachedToken returns `refreshed ?? token`),
  // and write/AI paths retry on 401 via backendFetchWithRetry. Losing a
  // silent refresh is strictly better than foregrounding the user's app.
  //
  // Set SH_ALLOW_NAV_REFRESH=1 to re-enable the legacy path for the rare
  // headless case where no background_page is available but a visible page
  // is (and stealing focus is acceptable).
  if (process.env.SH_ALLOW_NAV_REFRESH !== "1") {
    return undefined;
  }

  // 2-second timeout to bound CDP hangs (frozen JS context, devtools
  // breakpoint, etc.). Connection is forcefully closed on timeout to
  // unblock pending Runtime.evaluate calls.
  const CDP_REFRESH_TIMEOUT_MS = 2000;
  let conn: SuperhumanConnection | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeoutHandle = setTimeout(async () => {
      if (conn) {
        try { await disconnect(conn); } catch {}
        conn = null;
      }
      resolve(undefined);
    }, CDP_REFRESH_TIMEOUT_MS);
  });

  const refreshPromise = (async () => {
    try {
      conn = await connectToSuperhuman(port, false);
      if (!conn) return undefined;
      return await extractAndCache(conn, email);
    } catch {
      return undefined;
    } finally {
      if (conn) {
        try { await disconnect(conn); } catch {}
        conn = null;
      }
    }
  })();

  const result = await Promise.race([refreshPromise, timeoutPromise]);
  clearTimeout(timeoutHandle!);
  return result;
}

/**
 * Bulk-refresh every cached account, silently, in one pass.
 *
 * Deployment-agnostic — tries both valid refresh sources:
 *   1. Electron: the background_page iframes (one CDP connection for all
 *      accounts).
 *   2. Web/Chrome-extension: the Superhuman backend's sessions.getTokens,
 *      authenticated by the browser's session cookies (one cookie read + one
 *      CSRF token for all accounts).
 *
 * Returns the number of accounts refreshed, or null if neither source was
 * reachable at all (no app, no browser session).
 */
export async function refreshAllTokens(): Promise<number | null> {
  const cachedEmails = Array.from(tokenCache.keys());
  if (cachedEmails.length === 0) return 0;
  const port = await discoverSuperhumanPort();

  const viaIframe = await refreshAllViaBackgroundPage(cachedEmails, port);
  if (viaIframe && viaIframe.length > 0) {
    await persistRefreshedTokens(viaIframe);
    return viaIframe.length;
  }

  const viaSession = await refreshManyViaSessionCookies(
    cachedEmails.map((email) => ({ email, existing: tokenCache.get(email) })),
    port
  );
  if (viaSession.length > 0) {
    await persistRefreshedTokens(viaSession);
    return viaSession.length;
  }

  return null;
}

/**
 * Insert pre-extracted TokenInfo records into the cache and flush to disk.
 *
 * Used by `account auth` to seed the cache from a fresh background_page
 * extraction, where the caller already has the TokenInfo list and just
 * needs persistence.
 */
export async function persistRefreshedTokens(tokens: TokenInfo[]): Promise<void> {
  if (tokens.length === 0) return;
  for (const t of tokens) {
    if (t.idToken && !t.superhumanToken) {
      t.superhumanToken = { token: t.idToken, expires: t.idTokenExpires ?? t.expires };
    }
    tokenCache.set(t.email, t);
  }
  await saveTokensToDisk();
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
    // Token expired or expiring soon — try on-demand refresh via CDP.
    // If CDP is unavailable (Chrome not running, timeout), fall back to
    // returning the stale token so the caller can attempt the Superhuman
    // backend API. The backend handles 401 with its own retry logic, and
    // returning undefined here causes a misleading "No cached tokens" error
    // when the account IS known but tokens simply need refreshing.
    const refreshed = await refreshTokenViaCDP(email);
    return refreshed ?? token;
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

/**
 * Resolve a Superhuman token for any CLI operation.
 *
 * Resolution order:
 *  1. Cached token for the requested email (auto-refreshes via CDP if expired)
 *  2. Any cached account with valid Superhuman credentials
 *  3. Cold-start: connect to CDP, extract token for the currently active account
 *
 * Works for both Google and Microsoft accounts — Superhuman always authenticates
 * to its backend via Firebase JWT regardless of the underlying OAuth provider.
 */
export async function resolveToken(email?: string): Promise<TokenInfo | null> {
  await loadTokensFromDisk();

  // 1. Try requested account (getCachedToken auto-refreshes via CDP if expired)
  if (email) {
    const token = await getCachedToken(email);
    if (token?.idToken && token?.userId) return token;

    // If the email is not in tokenCache at all, the account was never authenticated.
    // Return null immediately — the user must run 'superhuman account auth' first.
    // Do NOT fall through to CDP cold-start for completely unknown accounts.
    if (!tokenCache.has(email)) {
      return null;
    }

    // The account IS known (exists in tokenCache from disk) but the token is
    // expired and the 2s CDP refresh in getCachedToken timed out. Fall through
    // to CDP cold-start below to extract a fresh token for this specific account.
  }

  // 2. Try any cached account with valid Superhuman credentials
  if (!email) {
    for (const cachedEmail of tokenCache.keys()) {
      const token = await getCachedToken(cachedEmail);
      if (token?.idToken && token?.userId) return token;
    }
  }

  // 3a. Cold-start via background_page iframes (silent, no focus steal).
  //     If bg page is reachable, bulk-refresh all accounts in one shot
  //     and return the requested (or any valid) token.
  try {
    const iframeResults = await refreshAllViaBackgroundPage(
      email ? [email] : undefined,
      await discoverSuperhumanPort(),
    );
    if (iframeResults && iframeResults.length > 0) {
      for (const t of iframeResults) {
        if (t.idToken) {
          t.superhumanToken = { token: t.idToken, expires: t.idTokenExpires ?? t.expires };
        }
        tokenCache.set(t.email, t);
      }
      await saveTokensToDisk();
      const picked = email
        ? iframeResults.find((t) => t.email === email)
        : iframeResults.find((t) => t.idToken && t.userId);
      if (picked && picked.idToken && picked.userId) return picked;
    }
  } catch {
    // Fall through to legacy nav-based cold-start.
  }

  // 3b. Legacy cold-start: connect to the visible mail page and extract
  //     (uses switchAccount → Page.navigate → focus steal). Only used
  //     when the background_page target isn't reachable.
  //
  //     Apply a timeout: Runtime.evaluate can hang indefinitely if the JS
  //     context is frozen (DevTools open with a breakpoint).
  const CDP_COLDSTART_TIMEOUT_MS = 8000;
  let coldConn: SuperhumanConnection | null = null;
  let coldTimeoutHandle: ReturnType<typeof setTimeout>;

  const coldTimeoutPromise = new Promise<null>((resolve) => {
    coldTimeoutHandle = setTimeout(async () => {
      if (coldConn) {
        try { await disconnect(coldConn); } catch {}
        coldConn = null;
      }
      resolve(null);
    }, CDP_COLDSTART_TIMEOUT_MS);
  });

  const coldStartPromise = (async (): Promise<TokenInfo | null> => {
    try {
      coldConn = await connectToSuperhuman(await discoverSuperhumanPort(), false);
      if (!coldConn) return null;

      if (email) {
        // Known account with expired token — extract fresh token for this account
        return await extractAndCache(coldConn, email);
      }

      // No account specified — use whatever is currently active
      const emailResult = await coldConn.Runtime.evaluate({
        expression: `window.GoogleAccount?.emailAddress || null`,
        returnByValue: true,
      });
      const activeEmail: string | null = emailResult.result.value;
      if (!activeEmail) return null;
      return await extractAndCache(coldConn, activeEmail);
    } catch {
      return null;
    } finally {
      if (coldConn) {
        try { await disconnect(coldConn); } catch {}
        coldConn = null;
      }
    }
  })();

  const coldResult = await Promise.race([coldStartPromise, coldTimeoutPromise]);
  clearTimeout(coldTimeoutHandle!);
  return coldResult;
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
  options?: RequestInit,
  /** Email for CDP refresh on 401. If provided, retries once after refresh. */
  email?: string,
): Promise<any | null> {
  const doFetch = async (t: string) => {
    const url = `${SUPERHUMAN_BACKEND_BASE}${path}`;
    return fetch(url, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${t}`,
        "Content-Type": "text/plain;charset=UTF-8",
      },
    });
  };

  let response = await doFetch(token);

  if ((response.status === 401 || response.status === 403) && email) {
    const refreshed = await refreshTokenViaCDP(email);
    if (refreshed?.superhumanToken) {
      response = await doFetch(refreshed.superhumanToken.token);
    }
  }

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
  /** Provider message ids of all non-draft messages (for outgoing_message.current_message_ids).
   *  Populated from the Superhuman backend thread (correct ids); left empty on the MS Graph
   *  fallback because Graph item-ids differ from Superhuman's internal message ids. */
  messageIds?: string[];
  /** True when messageIds came from real per-message records (backend thread map),
   *  so a single id equal to the thread id is a genuine single-message thread,
   *  not the conversation-id fallback. */
  idsVerified?: boolean;
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
    // The backend does NOT support `threadIds` filter — it returns empty
    // results. Use an empty filter and match client-side, same approach as
    // readThreadBackend() in read.ts.
    const result = await superhumanFetch(authToken, "/v3/userdata.getThreads", {
      method: "POST",
      body: JSON.stringify({
        filter: {},
        offset: 0,
        limit: 50,
      }),
    });

    if (!result || !result.threadList || result.threadList.length === 0) {
      return null;
    }

    // Find the thread containing a message that matches the given ID
    let threadData: any = null;
    for (const item of result.threadList) {
      const thread = item?.thread;
      if (!thread?.messages) continue;
      const msgs = Object.values(thread.messages) as any[];
      const match = msgs.some(
        (m: any) =>
          m.threadId === threadId ||
          m.id === threadId ||
          (m.id && threadId.includes(m.id))
      );
      if (match) {
        threadData = item;
        break;
      }
    }

    if (!threadData) {
      return null;
    }

    const messages = threadData.thread?.messages || {};
    const entries = Object.entries(messages) as [string, any][];

    if (entries.length === 0) {
      return null;
    }

    // Sort oldest→newest by message date so both "last message" selection and the
    // messageIds order are deterministic (the message map's key order is arbitrary).
    const dateOf = (m: any) =>
      new Date((m?.message || m?.draft || m)?.date || 0).getTime();
    entries.sort(([, a], [, b]) => dateOf(a) - dateOf(b));

    // Get the last message (most recent) for reply metadata
    const lastMsg = entries[entries.length - 1]![1];
    const msg = lastMsg.message || lastMsg.draft || lastMsg;

    return {
      subject: msg.subject || threadData.thread?.subject || "",
      from: msg.from || "",
      to: Array.isArray(msg.to) ? msg.to : msg.to ? [msg.to] : [],
      cc: Array.isArray(msg.cc) ? msg.cc : msg.cc ? [msg.cc] : [],
      messageId: msg.messageId || msg.rfc822Id || null,
      references: Array.isArray(msg.references) ? msg.references : [],
      // Message-map keys are the Superhuman provider message ids; exclude drafts,
      // oldest→newest to match the app's current_message_ids ordering.
      messageIds: entries
        .filter(([, m]: [string, any]) => !m?.draft && !(m?.labelIds || []).includes("DRAFT"))
        .map(([id]) => id),
      idsVerified: true,
    };
  } catch (_e) {
    return null;
  }
}

/**
 * Get thread info (subject, from, to, cc, messageId, references) via MS Graph API.
 *
 * Used as a fallback for Microsoft/Exchange accounts when `userdata.getThreads`
 * returns 400 (it does not support MS account requests from CLI context).
 *
 * Queries: GET /me/messages?$filter=conversationId eq '{threadId}'
 * Returns the last message's metadata for reply threading headers.
 *
 * @param threadId - Conversation/thread ID (same as MS Graph conversationId)
 * @param accessToken - MS Graph OAuth access token
 */
export async function getThreadInfoMsGraph(
  threadId: string,
  accessToken: string
): Promise<ThreadInfoDirect | null> {
  try {
    const select = [
      "id",
      "subject",
      "from",
      "toRecipients",
      "ccRecipients",
      "internetMessageId",
      "receivedDateTime",
    ].join(",");

    // Primary path: Superhuman passes the MS Graph message ID as threadId for
    // Outlook/Exchange accounts. Try a direct message lookup first — O(1) and
    // always succeeds when threadId is a valid message ID.
    const directUrl = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(threadId)}?$select=${select}`;
    const directResp = await fetch(directUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (directResp.ok) {
      const msg = await directResp.json() as any;
      const fromAddr = msg.from?.emailAddress;
      const fromStr = fromAddr?.name
        ? `${fromAddr.name} <${fromAddr.address}>`
        : fromAddr?.address || "";
      const toList = (msg.toRecipients || []).map((r: any) => {
        const addr = r.emailAddress;
        return addr?.name ? `${addr.name} <${addr.address}>` : (addr?.address || "");
      });
      const ccList = (msg.ccRecipients || []).map((r: any) => {
        const addr = r.emailAddress;
        return addr?.name ? `${addr.name} <${addr.address}>` : (addr?.address || "");
      });
      return {
        subject: msg.subject || "",
        from: fromStr,
        to: toList,
        cc: ccList,
        messageId: msg.internetMessageId || null,
        references: [],
      };
    }

    // Fallback: threadId might be a conversationId — filter at folder level.
    // Note: $filter=conversationId at /me/messages returns InefficientFilter (400)
    // for many Exchange tenants. Folder-level filtering also returns 400 on some
    // tenants (confirmed on UVA Law). This path is retained for compatibility but
    // may not work on all tenants.
    const folders = ["Inbox", "SentItems", "Archive", "DeletedItems"];
    const filterParam = `conversationId eq '${threadId}'`;
    const queryParams = `?$filter=${encodeURIComponent(filterParam)}&$select=${select}&$orderby=receivedDateTime+asc&$top=50`;

    let items: any[] = [];
    for (const folder of folders) {
      const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages${queryParams}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!resp.ok) continue;
      const data = await resp.json() as { value?: any[] };
      const folderItems: any[] = data.value || [];
      items = items.concat(folderItems);
      if (items.length > 0) break;
    }
    if (items.length === 0) return null;

    // Sort ascending by receivedDateTime to get last (most recent) message
    items.sort(
      (a, b) =>
        new Date(a.receivedDateTime || 0).getTime() -
        new Date(b.receivedDateTime || 0).getTime()
    );
    const last = items[items.length - 1];

    const fromAddr = last.from?.emailAddress;
    const fromStr = fromAddr?.name
      ? `${fromAddr.name} <${fromAddr.address}>`
      : fromAddr?.address || "";

    const toList = (last.toRecipients || []).map((r: any) => {
      const addr = r.emailAddress;
      return addr?.name ? `${addr.name} <${addr.address}>` : (addr?.address || "");
    });
    const ccList = (last.ccRecipients || []).map((r: any) => {
      const addr = r.emailAddress;
      return addr?.name ? `${addr.name} <${addr.address}>` : (addr?.address || "");
    });

    return {
      subject: last.subject || "",
      from: fromStr,
      to: toList,
      cc: ccList,
      messageId: last.internetMessageId || null,
      references: [],
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
export interface AIRetrieval {
  /** Thread ID (hex string) */
  thread_id: string;
  /** Message ID (may equal thread_id for single-message threads) */
  message_id: string;
  /** Email subject */
  subject: string;
  /** Sender "Name <email>" string */
  from: string;
  /** Recipient "Name <email>" string */
  to?: string;
  /** Message date (ISO string) */
  date: string;
  /** 1-based citation index used in the AI response text */
  index: number;
}

export interface AIQueryResult {
  response: string;
  sessionId: string;
  /** Retrieved email threads that back the AI response citations */
  retrievals: AIRetrieval[];
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
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf-8");
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

  const doFetch = (token: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify(payload),
    });

  let fetchResponse = await doFetch(superhumanToken);

  // The id-token (~1h TTL) may have expired; refresh once via CDP and retry.
  if ((fetchResponse.status === 401 || fetchResponse.status === 403) && options?.email) {
    const refreshed = await refreshTokenViaCDP(options.email);
    const newToken = refreshed?.superhumanToken?.token || refreshed?.idToken;
    if (newToken && newToken !== superhumanToken) {
      fetchResponse = await doFetch(newToken);
    }
  }

  if (fetchResponse.status === 401 || fetchResponse.status === 403) {
    throw new Error("AI query failed - authentication error");
  }

  if (!fetchResponse.ok) {
    const errorText = await fetchResponse.text().catch(() => "Unknown error");
    throw new Error(`AI query failed: ${fetchResponse.status} ${fetchResponse.statusText} - ${errorText}`);
  }

  // Parse the SSE streaming response using a streaming reader.
  // askAIProxy uses transfer-encoding: chunked and keeps the connection open,
  // so fetchResponse.text() would hang indefinitely. We read chunks as they
  // arrive and stop when we see [DONE] or the stream closes.
  const reader = fetchResponse.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  // Track retrievals by thread_id to deduplicate; keep lowest index per thread
  const retrievalMap = new Map<string, AIRetrieval>();

  const processLine = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const jsonStr = line.substring(6).trim();
    if (jsonStr === "[DONE]" || jsonStr === "END" || jsonStr === "") return;

    try {
      const data = JSON.parse(jsonStr);
      // askAIProxy format: content at top level (cumulative)
      if (typeof data.content === "string") {
        fullContent = data.content;
      }
      // Collect retrieved email threads from `retrievals` field
      if (Array.isArray(data.retrievals)) {
        for (const r of data.retrievals) {
          const tid = r.thread_id as string | undefined;
          if (!tid) continue;
          // Keep the first occurrence (lowest index) per thread
          if (!retrievalMap.has(tid)) {
            retrievalMap.set(tid, {
              thread_id: tid,
              message_id: (r.message_id as string) || tid,
              subject: (r.subject as string) || "",
              from: (r.from as string) || "",
              to: r.to as string | undefined,
              date: (r.date as string) || "",
              index: (r.index as number) || 0,
            });
          }
        }
      }
    } catch {
      // Ignore non-JSON lines
    }
  };

  let done = false;
  while (!done) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    // Process all complete lines in the buffer
    const lines = buffer.split("\n");
    // Last element may be incomplete — keep it in buffer
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      processLine(line.trim());
    }
    // Stop reading once we've received the [DONE] sentinel
    if (buffer.includes("data: [DONE]") || buffer.includes("data: END")) {
      done = true;
    }
  }
  // Process any remaining buffered lines
  for (const line of buffer.split("\n")) {
    processLine(line.trim());
  }

  // Strip <thinking>...</thinking> tags from the response
  fullContent = fullContent.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim();

  // Sort retrievals by citation index
  const retrievals = [...retrievalMap.values()].sort((a, b) => a.index - b.index);

  return {
    response: fullContent,
    sessionId,
    retrievals,
  };
}
