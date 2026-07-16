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
import { getCDPHost } from "./superhuman-api";
import { classifyTarget, discoverEndpoint } from "./cdp-endpoint";
import type { TokenInfo } from "./token-api";

const ACCOUNTS_HOST = "https://accounts.superhuman.com";
/** URLs whose cookies the page-target fallback asks for. */
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

const DEFAULT_CDP_TIMEOUT_MS = 10_000;

/**
 * Per-target ceiling inside the page sweep.
 *
 * Without it, handing each call the whole remaining budget means the first tab
 * that HANGS (rather than errors) consumes everything and the deadline then
 * skips every later candidate — measured: a wedged tab burned 10002ms and the
 * sweep yielded nothing while three responsive tabs sat further down the list.
 * The sweep could only advance on a fast failure, never on a hang, which is the
 * one failure mode it exists to survive. Responsive targets answer in ~20ms.
 */
const PER_TARGET_CAP_MS = 2_000;

/**
 * Upper bound on a single CDP round-trip, and on the whole cookie read.
 *
 * Validated rather than trusted: an unparseable or non-positive value would
 * make setTimeout fire immediately (setTimeout(fn, NaN) is setTimeout(fn, 0)),
 * so every call would "time out", the read would return null, and the caller
 * would silently keep a stale token — a config typo turning into an invisible
 * auth failure.
 */
function cdpTimeoutMs(): number {
  const raw = process.env.CDP_TIMEOUT_MS;
  if (!raw) return DEFAULT_CDP_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CDP_TIMEOUT_MS;
  return n;
}

/** Hosts whose cookies authenticate the backend calls below. */
const COOKIE_HOSTS = ["accounts.superhuman.com", "mail.superhuman.com"];

/**
 * Does a cookie apply to `host`, per RFC 6265 §5.1.3 domain-matching?
 *
 * A leading dot means the cookie covers the domain and its subdomains;
 * otherwise it is host-only and must match exactly.
 */
export function cookieDomainMatches(domain: string, host: string): boolean {
  const d = domain.toLowerCase();
  const h = host.toLowerCase();
  if (d.startsWith(".")) {
    const base = d.slice(1);
    return h === base || h.endsWith(`.${base}`);
  }
  return d === h;
}

/**
 * Does a cookie's path apply to `requestPath`, per RFC 6265 §5.1.4?
 *
 * Cookie-path "/" matches everything; "/foo" matches "/foo" and "/foo/bar" but
 * NOT "/". Storage.getCookies takes no `urls` filter and returns the entire
 * store, so without this we would admit cookies the browser would never send —
 * Network.getCookies({ urls }) applied path scoping for us. A store holding
 * `csrf=current; Path=/` alongside `csrf=old; Path=/legacy` would otherwise
 * yield `csrf=current; csrf=old` and let the backend pick.
 */
export function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
  const p = cookiePath || "/";
  if (p === requestPath) return true;
  if (!requestPath.startsWith(p)) return false;
  return p.endsWith("/") || requestPath[p.length] === "/";
}

/**
 * Does a cookie apply to a request for `host` at `path` over HTTPS?
 *
 * Reproduces the scoping Network.getCookies({ urls: COOKIE_URLS }) did for us.
 * Without it we would pick up same-named cookies from other superhuman.com
 * subdomains (media.* carries its own device-id) and path-scoped duplicates.
 */
function cookieApplies(c: RawCookie, host: string, path: string): boolean {
  if (!cookieDomainMatches(c.domain, host)) return false;
  return cookiePathMatches(c.path ?? "/", path);
}

/** Shape both cookie reads return. */
interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

/** Path the backend calls actually hit — cookies must be in scope for it. */
const BACKEND_PATH = "/~backend/v3/";

/**
 * Build the Cookie header from a raw cookie list, or null if none apply.
 *
 * Ordered per RFC 6265 §5.4: longer paths first. Storage.getCookies returns the
 * store in unspecified order, and a server that takes the FIRST occurrence of a
 * duplicated name would otherwise see the wrong value — e.g. `session` at both
 * `/` and `/~backend` must send the `/~backend` one first, as a browser would.
 */
export function toCookieHeader(cookies: RawCookie[] | undefined): string | null {
  if (!cookies?.length) return null;
  const relevant = cookies.filter((c) =>
    COOKIE_HOSTS.some((h) => cookieApplies(c, h, BACKEND_PATH))
  );
  if (!relevant.length) return null;
  const ordered = [...relevant].sort(
    (a, b) => (b.path ?? "/").length - (a.path ?? "/").length
  );
  return ordered.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** A deadline shared across every step of one cookie read. */
interface Deadline {
  remaining(): number;
  expired(): boolean;
}

function deadlineIn(ms: number): Deadline {
  const end = Date.now() + ms;
  return {
    remaining: () => Math.max(0, end - Date.now()),
    expired: () => Date.now() >= end,
  };
}

/**
 * Read cookies from the BROWSER-level target via Storage.getCookies.
 *
 * The browser endpoint has no renderer, so nothing can wedge it, and it needs
 * no Superhuman tab — or any tab — to be open. This is the preferred route.
 *
 * Returns null (never throws) if the endpoint is unreachable or the browser
 * does not serve Storage there, so the caller can fall back.
 */
async function readCookiesFromBrowserTarget(
  host: string,
  port: number,
  deadline: Deadline
): Promise<RawCookie[] | null> {
  // Attach by websocket URL. target:"browser" does NOT work — chrome-remote-
  // interface treats a target string as a target id and looks it up in
  // CDP.List(), which never contains the browser itself. CDP.Version() (not
  // fetch) keeps discovery on the library's transport, so callers asserting
  // "no network call without a browser" still hold.
  let browserWsUrl: string;
  try {
    const ver = (await withTimeout(
      CDP.Version({ host, port }),
      "CDP.Version",
      deadline.remaining()
    )) as { webSocketDebuggerUrl?: string };
    if (!ver.webSocketDebuggerUrl) return null;
    browserWsUrl = ver.webSocketDebuggerUrl;
  } catch {
    return null;
  }

  let client: CDP.Client | null = null;
  try {
    // The attach itself must be bounded: a target can advertise a websocket
    // endpoint and then never complete the handshake, which would hang here
    // before any bounded command ran.
    client = await attachWithTimeout(
      CDP({ target: browserWsUrl, host, port }),
      "CDP attach (browser)",
      deadline.remaining()
    );
    const { cookies } = await withTimeout(
      client.Storage.getCookies({}),
      "Storage.getCookies",
      deadline.remaining()
    );
    return cookies ?? null;
  } catch {
    // Includes an Electron/browser that does not serve Storage on its browser
    // endpoint — the command rejects and we fall back to page targets.
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

/**
 * Fallback: read cookies via a page target's Network.getCookies.
 *
 * Only reached when the browser target is unavailable. Tries Superhuman tabs
 * first, then other pages, and — crucially — moves on to the next candidate
 * when one does not answer within the timeout, rather than betting everything
 * on a single tab.
 */
async function* readCookiesFromPageTargets(
  host: string,
  port: number,
  deadline: Deadline
): AsyncGenerator<RawCookie[]> {
  let targets: any[];
  try {
    targets = await withTimeout(CDP.List({ host, port }), "CDP.List", deadline.remaining());
  } catch {
    return;
  }

  const pages = targets.filter((t: any) => t.type === "page");
  // Superhuman tabs first: most likely responsive and on the right profile.
  // classifyTarget rather than a substring — an impostor host must not be
  // promoted ahead of the genuine tab.
  const ordered = [
    ...pages.filter((t: any) => classifyTarget(t) !== null),
    ...pages.filter((t: any) => classifyTarget(t) === null),
  ];

  for (const target of ordered) {
    // One shared deadline across the whole sweep — otherwise N wedged tabs cost
    // N x timeout (measured: a single wedged tab burns the full 10s), and a
    // browser with dozens of tabs could stall the CLI for minutes.
    if (deadline.expired()) return;
    let client: CDP.Client | null = null;
    try {
      const budget = () => Math.min(deadline.remaining(), PER_TARGET_CAP_MS);
      client = await attachWithTimeout(
        CDP({ target: target.id, host, port }),
        "CDP attach (page)",
        budget()
      );
      await withTimeout(client.Network.enable(), "Network.enable", budget());
      const { cookies } = await withTimeout(
        client.Network.getCookies({ urls: COOKIE_URLS }),
        "Network.getCookies",
        budget()
      );
      if (cookies?.length) yield cookies;
    } catch {
      // This target wedged or errored — try the next one.
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
}

/**
 * Read Superhuman's session cookies out of the live browser via CDP and
 * format them as a `Cookie` request header.
 *
 * Prefers the BROWSER-level target (`Storage.getCookies`), falling back to page
 * targets (`Network.getCookies`).
 *
 * Why not page targets first: the extension's own targets refuse CDP attachment
 * (see the module header), which is why this path reads cookies at all — but
 * page targets are not dependable either. A CDP command routed through a page
 * goes through its renderer, and a busy renderer simply never answers. Measured
 * against a live browser with six page targets, `Network.getCookies` hung
 * indefinitely on one while the other five answered in milliseconds, and *which*
 * one hangs drifts (a tab that hung on one probe answered three hours later,
 * while a different tab had started hanging). It tracks renderer busyness, not
 * the site, so no page target can be assumed responsive. The browser endpoint
 * has no renderer and cannot wedge.
 *
 * Why keep page targets at all: the browser-level read is verified against
 * Chromium, but the desktop deployment is Electron (port 9252) and has not been
 * verified to serve `Storage` on its browser endpoint. Falling back means the
 * worst case there is the previous behaviour, not a regression.
 *
 * Both routes are bounded, and the fallback advances past a target that does
 * not answer instead of betting on one tab — so a wedged renderer costs a
 * timeout, not the refresh.
 *
 * Returns null when no browser is reachable or no Superhuman cookies exist.
 */
export async function readSessionCookieHeader(
  port?: number
): Promise<string | null> {
  const host = getCDPHost();
  const deadline = deadlineIn(cdpTimeoutMs());

  // An explicit port is honoured; otherwise probe the desktop app, then Chrome.
  // This module exists FOR the Chrome-extension deployment, yet used to default
  // to the Electron port (9252) and only worked because callers happened to
  // thread a resolved port down.
  let resolved: number;
  if (port !== undefined) {
    resolved = port;
  } else {
    try {
      resolved = (await discoverEndpoint()).port;
    } catch {
      return null; // no endpoint at all — caller keeps the stale token
    }
  }

  const fromBrowser = toCookieHeader(
    (await readCookiesFromBrowserTarget(host, resolved, deadline)) ?? undefined
  );
  if (fromBrowser) return fromBrowser;

  for await (const cookies of readCookiesFromPageTargets(host, resolved, deadline)) {
    const header = toCookieHeader(cookies);
    if (header) return header;
  }
  return null;
}

/**
 * KNOWN LIMITATION — the first usable cookie jar wins.
 *
 * Storage.getCookies reads the DEFAULT browser context, and a page can live in
 * another (incognito, or an Electron `webPreferences.partition`). So a populated
 * but stale default-context jar is returned without trying the page fallback.
 *
 * Gating on real authentication instead was implemented and reverted, for two
 * reasons. sessions.getCsrfToken is NOT an auth check — measured against the
 * live backend it returns 200 and a csrfToken with bogus cookies, and with no
 * Cookie header at all — so the only real proof is sessions.getTokens, and
 * looping that over every candidate turns a fast "no session" failure into a
 * full page sweep per account. That broke three read-hang regression tests, the
 * suite guarding exactly this class of bug. A real regression is not worth a
 * theoretical fix.
 *
 * Doing it properly means enumerating browserContextId from CDP.List and
 * reading each context via Storage.getCookies({ browserContextId }) — no page
 * attach, no sweep, and no cost when only the default context exists. Follow-up.
 */

/**
 * Bound an attach whose result must be closed if it lands after the timeout.
 *
 * withTimeout only stops waiting — it cannot abort the underlying connect. A
 * slow handshake that completes after we gave up would otherwise leave a live
 * websocket with no reference, leaking one per attempt.
 */
function attachWithTimeout(
  p: Promise<CDP.Client>,
  what: string,
  ms: number
): Promise<CDP.Client> {
  const bounded = withTimeout(p, what, ms);
  bounded.catch(() => {
    // We are no longer waiting; close it if it ever arrives.
    p.then(
      (client) => {
        try {
          void client.close();
        } catch {
          // ignore
        }
      },
      () => {
        // already rejected; nothing to close
      }
    );
  });
  return bounded;
}

/** Reject rather than wait forever — an unbounded CDP wait is the bug above. */
function withTimeout<T>(p: Promise<T>, what: string, ms = cdpTimeoutMs()): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Health probe: are Superhuman session cookies reachable in the browser?
 *
 * NOT a proof that the session is live. sessions.getCsrfToken returns 200 and a
 * token even with bogus cookies, or none at all (measured against the live
 * backend), so it cannot distinguish a signed-in session from a signed-out one
 * — and cookies survive sign-out. Proving liveness needs sessions.getTokens,
 * which requires an account and mints real credentials; too heavy for a probe.
 *
 * So this answers only "is there a browser with Superhuman cookies we could
 * try", which is what `superhuman doctor` needs to decide whether to tell the
 * user to relaunch an app. False positives are possible when signed out.
 */
export async function isSessionRefreshHealthy(
  port?: number
): Promise<boolean> {
  return (await readSessionCookieHeader(port)) !== null;
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
  port?: number
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
  port?: number
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
