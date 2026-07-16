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
 * contexts: it only reads cookies (which page targets serve fine) and then
 * talks HTTP to Superhuman's backend.
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
const COOKIE_URLS = [ACCOUNTS_HOST, "https://mail.superhuman.com"];

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

/**
 * Read Superhuman's session cookies out of the live browser via CDP and
 * format them as a `Cookie` request header.
 *
 * Uses a page target: `Network.getCookies` reads the shared browser cookie
 * store (the `urls` argument selects the cookies, not the page's origin), and
 * unlike the extension's own targets, page targets respond to CDP reliably.
 *
 * Returns null when no browser is reachable or no Superhuman cookies exist.
 */
export async function readSessionCookieHeader(
  port = getCDPPort()
): Promise<string | null> {
  const host = getCDPHost();
  let targets: any[];
  try {
    targets = await CDP.List({ host, port });
  } catch {
    return null;
  }

  // Prefer a Superhuman tab, but any page target can read the cookie store.
  const pages = targets.filter((t: any) => t.type === "page");
  const target =
    pages.find((t: any) => t.url.includes("superhuman.com")) ?? pages[0];
  if (!target) return null;

  let client: CDP.Client | null = null;
  try {
    client = await CDP({ target: target.id, host, port });
    await client.Network.enable();
    const { cookies } = await client.Network.getCookies({ urls: COOKIE_URLS });
    if (!cookies?.length) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
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
