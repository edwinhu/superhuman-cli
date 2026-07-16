/**
 * Session-Cookie Token Refresh (Superhuman backend `sessions.getTokens`)
 *
 * Mints fresh credentials for a linked account by calling Superhuman's own
 * backend session endpoint with the browser's long-lived Superhuman session
 * cookies — exactly what the app itself does when its 1-hour tokens expire.
 *
 * Why this exists
 * ---------------
 * The pre-existing refresh paths only work on the **Electron desktop app**:
 * `background-page-refresh.ts` needs a `background_page.html` target, and the
 * legacy fallback navigates a visible Electron window. On a **Chrome-extension
 * deployment** (Linux — mail.superhuman.com in Chromium, no Electron app) the
 * extension's service-worker and offscreen-document targets refuse CDP
 * attachment entirely (`Runtime.evaluate` never returns, not even `1+1`), so
 * every on-demand refresh failed and callers silently fell back to a stale
 * token. Anything hitting a live API with the cached OAuth token — notably
 * `attachment download` — then 401'd until the user manually re-ran
 * `superhuman account auth`. This path needs no CDP scripting of extension
 * contexts: it only reads cookies, and then talks HTTP to Superhuman's
 * backend.
 *
 * The cookie read goes to the browser-level target, not a page — page targets
 * are subject to the same never-answers failure when their renderer is busy
 * (see readSessionCookieHeader).
 *
 * The flow (reverse-engineered from the extension bundle,
 * `background/background_page.js` → `Credential.refreshSession()`):
 *
 *   GET  https://accounts.superhuman.com/~backend/v3/sessions.getCsrfToken
 *        → { csrfToken, expiresIn }
 *   POST https://accounts.superhuman.com/~backend/v3/sessions.getTokens
 *        headers: { "X-CSRF-Token": <csrfToken> }
 *        body:    { emailAddress, googleId }
 *        → { authData: { idToken, accessToken, expires, ... }, aliases, calendars }
 *
 * Both calls are cookie-authenticated (`credentials: "include"` in the app).
 * The session cookies live on `accounts.superhuman.com` and long outlive the
 * 1-hour tokens, so this refreshes without any interactive re-auth.
 *
 * This is provider-agnostic: the backend returns the Google *or* Microsoft
 * OAuth access token for the account, minted by Superhuman — the CLI never
 * touches a provider's OAuth flow itself.
 *
 * Discovered 2026-07-16 — see docs/investigations/2026-07-16_attachment_download_401.md
 */
import CDP from "chrome-remote-interface";
import { getCDPHost, getCDPPort } from "./superhuman-api";
import type { TokenInfo } from "./token-api";

const ACCOUNTS_HOST = "https://accounts.superhuman.com";

/** Backend response shape for sessions.getTokens (fields we consume). */
interface GetTokensResponse {
  authData?: {
    accessToken?: string;
    idToken?: string;
    expires?: number;
    emailAddress?: string;
    userId?: string;
  };
}

/** Upper bound on the cookie read. Override with CDP_TIMEOUT_MS. */
const CDP_TIMEOUT_MS = parseInt(process.env.CDP_TIMEOUT_MS || "10000", 10);

/** Hosts whose cookies authenticate the backend calls below. */
const COOKIE_HOSTS = ["accounts.superhuman.com", "mail.superhuman.com"];

/**
 * Does a cookie apply to `host`, per RFC 6265 domain-matching?
 *
 * A leading dot means the cookie covers the domain and its subdomains;
 * otherwise it is host-only and must match exactly. Storage.getCookies returns
 * the entire store with no `urls` filter, so this reproduces the scoping that
 * Network.getCookies({ urls }) used to do for us — without it we would also
 * pick up same-named cookies from other superhuman.com subdomains (media.*
 * carries its own device-id) and send duplicates with the wrong values.
 */
function cookieAppliesToHost(domain: string, host: string): boolean {
  const d = domain.toLowerCase();
  const h = host.toLowerCase();
  if (d.startsWith(".")) {
    const base = d.slice(1);
    return h === base || h.endsWith(`.${base}`);
  }
  return d === h;
}

/**
 * Read Superhuman's session cookies out of the live browser via CDP and
 * format them as a `Cookie` request header.
 *
 * Uses the BROWSER-level target (`Storage.getCookies`), not a page target.
 *
 * The extension's own targets refuse CDP attachment (see the module header),
 * which is why this path reads cookies at all. But page targets are not a safe
 * fallback either: a CDP command routed through a page goes through its
 * renderer, and a busy renderer simply never answers. Measured against a live
 * browser with six page targets, `Network.getCookies` hung indefinitely on one
 * of them while the other five answered in milliseconds — and *which* target
 * hangs drifts over time (a tab that hung on one probe answered three hours
 * later, while a different tab had started hanging). It is not a property of a
 * particular site, so no page target can be assumed responsive.
 *
 * That made the old `?? pages[0]` fallback a coin flip: with no Superhuman tab
 * open it attached to an arbitrary tab, and if that tab's renderer was wedged
 * the read never returned. A hang is not a rejection, so the surrounding
 * try/catch could not convert it into the documented `null` — the caller just
 * stopped, and on-demand refresh silently failed exactly as it did before this
 * module existed.
 *
 * The browser target has no renderer, so nothing can wedge it, and it needs no
 * Superhuman tab (or any tab) to be open. The read is still bounded, so a
 * future stall degrades to `null` rather than hanging.
 *
 * Returns null when no browser is reachable or no Superhuman cookies exist.
 */
export async function readSessionCookieHeader(
  port = getCDPPort()
): Promise<string | null> {
  const host = getCDPHost();

  // Attach to the browser endpoint by its websocket URL. Passing target:"browser"
  // does not work: chrome-remote-interface treats a target string as a target id
  // and looks it up in CDP.List(), which never contains the browser itself.
  // CDP.Version() (not fetch) keeps discovery on the library's own transport,
  // so callers that assert "no network call without a browser" still hold.
  let browserWsUrl: string;
  try {
    const ver = (await CDP.Version({ host, port })) as { webSocketDebuggerUrl?: string };
    if (!ver.webSocketDebuggerUrl) return null;
    browserWsUrl = ver.webSocketDebuggerUrl;
  } catch {
    return null;
  }

  let client: CDP.Client | null = null;
  try {
    client = await CDP({ target: browserWsUrl, host, port });
    const { cookies } = await withTimeout(
      client.Storage.getCookies({}),
      "Storage.getCookies"
    );
    if (!cookies?.length) return null;
    const relevant = cookies.filter((c) =>
      COOKIE_HOSTS.some((h) => cookieAppliesToHost(c.domain, h))
    );
    if (!relevant.length) return null;
    return relevant.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return null;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  }
}

/** Reject rather than wait forever — an unbounded CDP wait is the bug above. */
function withTimeout<T>(p: Promise<T>, what: string, ms = CDP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * Health probe: is the browser's Superhuman session usable for refresh?
 *
 * Reads the cookies and exchanges them for a CSRF token — cheap, read-only,
 * and a real proof the session is live (cookie presence alone isn't: they
 * survive sign-out). Used by `superhuman doctor`.
 */
export async function isSessionRefreshHealthy(
  port = getCDPPort()
): Promise<boolean> {
  const cookieHeader = await readSessionCookieHeader(port);
  if (!cookieHeader) return false;
  return (await getCsrfToken(cookieHeader)) !== null;
}

/** Fetch a CSRF token for the session (required by sessions.getTokens). */
async function getCsrfToken(cookieHeader: string): Promise<string | null> {
  try {
    const resp = await fetch(`${ACCOUNTS_HOST}/~backend/v3/sessions.getCsrfToken`, {
      headers: { Cookie: cookieHeader },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { csrfToken?: string };
    return data.csrfToken ?? null;
  } catch {
    return null;
  }
}

/** Decode a JWT's `exp` (ms). Returns undefined for opaque tokens (e.g. Google ya29.*). */
function jwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString()
    );
    return payload.exp ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mint fresh tokens for `email` via the Superhuman backend using the browser's
 * session cookies.
 *
 * @param email    Account to refresh.
 * @param existing Current TokenInfo, used to carry over metadata the backend
 *                 doesn't return (userId, userPrefix, deviceId, ...).
 * @returns Fresh TokenInfo, or null if the session isn't usable (no browser,
 *          no cookies, signed out, or the backend rejected the request).
 */
export async function refreshViaSessionCookies(
  email: string,
  existing?: TokenInfo,
  port = getCDPPort()
): Promise<TokenInfo | null> {
  const cookieHeader = await readSessionCookieHeader(port);
  if (!cookieHeader) return null;

  const csrfToken = await getCsrfToken(cookieHeader);
  if (!csrfToken) return null;

  return getTokensForEmail(email, cookieHeader, csrfToken, existing);
}

/**
 * Bulk variant: refresh several accounts against one cookie read and one CSRF
 * token. Used by `account auth` / `refreshAllTokens`, where re-reading cookies
 * per account would mean a CDP round-trip each time.
 *
 * @returns The accounts that refreshed successfully (may be empty).
 */
export async function refreshManyViaSessionCookies(
  entries: Array<{ email: string; existing?: TokenInfo }>,
  port = getCDPPort()
): Promise<TokenInfo[]> {
  if (entries.length === 0) return [];

  const cookieHeader = await readSessionCookieHeader(port);
  if (!cookieHeader) return [];

  const csrfToken = await getCsrfToken(cookieHeader);
  if (!csrfToken) return [];

  const results: TokenInfo[] = [];
  for (const { email, existing } of entries) {
    const token = await getTokensForEmail(email, cookieHeader, csrfToken, existing);
    if (token) results.push(token);
  }
  return results;
}

/** POST sessions.getTokens for one account and map the response to TokenInfo. */
async function getTokensForEmail(
  email: string,
  cookieHeader: string,
  csrfToken: string,
  existing?: TokenInfo
): Promise<TokenInfo | null> {
  let data: GetTokensResponse;
  try {
    const resp = await fetch(`${ACCOUNTS_HOST}/~backend/v3/sessions.getTokens`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "X-CSRF-Token": csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        emailAddress: email,
        // The app sends the account's provider user id here; the backend
        // resolves the session from the cookie + emailAddress, and accepts
        // null when we don't have one cached.
        googleId: existing?.userId ?? null,
      }),
    });
    if (!resp.ok) return null;
    data = (await resp.json()) as GetTokensResponse;
  } catch {
    return null;
  }

  const authData = data.authData;
  if (!authData?.accessToken) return null;

  // Prefer the JWT's own exp (Microsoft); fall back to the backend's `expires`
  // for opaque Google access tokens, then to a conservative 1-hour default.
  const accessExpires =
    jwtExpiryMs(authData.accessToken) ??
    authData.expires ??
    Date.now() + 60 * 60 * 1000;

  const idToken = authData.idToken;
  const idTokenExpires = jwtExpiryMs(idToken) ?? authData.expires;

  return {
    ...existing,
    accessToken: authData.accessToken,
    email,
    expires: accessExpires,
    isMicrosoft: existing?.isMicrosoft ?? false,
    userId: authData.userId ?? existing?.userId,
    idToken: idToken ?? existing?.idToken,
    idTokenExpires: idTokenExpires ?? existing?.idTokenExpires,
    superhumanToken: idToken
      ? { token: idToken, expires: idTokenExpires }
      : existing?.superhumanToken,
  } as TokenInfo;
}
