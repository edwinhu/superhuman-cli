/**
 * Outlook Web (OWA) token broker.
 *
 * Piggybacks the already-authenticated Outlook Web session running in the CDP
 * browser (port 9222): reads the session's own first-party access token
 * ("One Outlook Web" app, aud=https://outlook.office.com, full Mail.* scopes)
 * from the page's MSAL localStorage cache. No new OAuth grant is required — this
 * is the only no-consent path on tenants (e.g. UVA) that gate third-party apps
 * behind admin consent.
 *
 * The token carries Mail.ReadWrite / Mail.Send and lasts ~24h; MSAL in the OWA
 * page silently re-mints it while the browser stays signed in. When our cached
 * copy is stale we reload the OWA tab to force a fresh mint, then re-read.
 */

import CDP from "chrome-remote-interface";
import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getCDPHost, cdpPortCandidates, hostMatches } from "./cdp-endpoint";

/** Hosts that indicate a logged-in Outlook Web tab. */
const OWA_HOSTS = ["outlook.cloud.microsoft", "outlook.office.com", "outlook.office365.com"];

/** Refresh when this close to (or past) expiry. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** How long to wait after a tab reload for OWA to bootstrap + re-mint the token. */
const RELOAD_SETTLE_MS = 4500;

/** Upper bound on any single CDP round-trip, so a wedged tab fails fast. */
const CDP_OP_TIMEOUT_MS = 10_000;

/**
 * Reject rather than wait forever. A wedged Outlook Web tab (renderer busy,
 * mid-navigation, or crashed) answers /json but never responds to
 * Runtime.evaluate/Page.reload — an unbounded await there hangs the whole CLI.
 */
function withTimeout<T>(p: Promise<T>, what: string, ms = CDP_OP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} timed out after ${ms}ms — the Outlook Web tab is unresponsive. ` +
              "Refresh/reopen Outlook Web in the browser, then retry."
          )
        ),
      ms
    );
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

export interface OwaToken {
  accessToken: string;
  /** Account UPN / email, decoded from the token's `upn` claim. */
  email: string;
  /** Expiry as ms epoch. */
  expiresOn: number;
}

const memCache = new Map<string, OwaToken>();

/** Config dir — honors SUPERHUMAN_CLI_CONFIG_DIR so tests stay isolated. */
function configDir(): string {
  return (
    process.env.SUPERHUMAN_CLI_CONFIG_DIR ||
    join(homedir(), ".config", "superhuman-cli")
  );
}

function cacheFile(): string {
  return join(configDir(), "owa-tokens.json");
}

async function loadDiskCache(): Promise<Record<string, OwaToken>> {
  try {
    return JSON.parse(await fs.readFile(cacheFile(), "utf8"));
  } catch {
    return {};
  }
}

async function saveDiskCache(map: Record<string, OwaToken>): Promise<void> {
  const file = cacheFile();
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(file, JSON.stringify(map, null, 2), { mode: 0o600 });
}

function isFresh(tok: OwaToken | undefined): tok is OwaToken {
  return !!tok && tok.expiresOn - Date.now() > EXPIRY_BUFFER_MS;
}

/** Decode a JWT payload without verifying (we only read claims we already trust). */
function decodeJwt(jwt: string): Record<string, any> {
  const seg = jwt.split(".")[1];
  if (!seg) return {};
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    return JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

/** The in-page function that mines the MSAL cache for the OWA mail token. */
const READ_MSAL_EXPR = `(function () {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    let v = localStorage.getItem(k);
    try {
      const o = JSON.parse(v);
      if (
        o && typeof o.credentialType === "string" &&
        o.credentialType.indexOf("AccessToken") === 0 &&
        typeof o.target === "string" &&
        o.target.indexOf("https://outlook.office.com/Mail.ReadWrite") !== -1 &&
        o.secret
      ) {
        return JSON.stringify({ secret: o.secret, expiresOn: o.expiresOn });
      }
    } catch (e) {}
  }
  return null;
})()`;

interface OwaCdpTarget {
  id: string;
  url: string;
}

/** Find the logged-in Outlook Web page target on the running CDP browser. */
async function findOwaTarget(
  host: string,
  port: number
): Promise<OwaCdpTarget | null> {
  let targets: any[];
  try {
    targets = (await withTimeout(
      CDP.List({ host, port }) as Promise<any[]>,
      `CDP target list on port ${port}`
    )) as any[];
  } catch {
    return null;
  }
  const owa = targets.find(
    (t) =>
      t?.type === "page" &&
      typeof t.url === "string" &&
      OWA_HOSTS.some((h) => hostMatches(t.url, h))
  );
  return owa ? { id: owa.id, url: owa.url } : null;
}

/** Read the token from the OWA tab's MSAL cache, optionally reloading first. */
async function scrapeToken(
  host: string,
  port: number,
  target: OwaCdpTarget,
  reload: boolean
): Promise<OwaToken | null> {
  const client = await withTimeout(
    CDP({ target: target.id, host, port }),
    "CDP attach to Outlook Web tab"
  );
  try {
    if (reload) {
      await withTimeout(client.Page.enable(), "Page.enable");
      await withTimeout(client.Page.reload({ ignoreCache: false }), "Page.reload");
      await new Promise((r) => setTimeout(r, RELOAD_SETTLE_MS));
    }
    const { result, exceptionDetails } = await withTimeout(
      client.Runtime.evaluate({
        expression: READ_MSAL_EXPR,
        returnByValue: true,
      }),
      "reading the Outlook Web token"
    );
    if (exceptionDetails || !result?.value) return null;
    const parsed = JSON.parse(result.value as string) as {
      secret: string;
      expiresOn: string | number;
    };
    const claims = decodeJwt(parsed.secret);
    const email: string = claims.upn || claims.unique_name || claims.preferred_username || "";
    const expiresOn = Number(parsed.expiresOn) * 1000;
    if (!email || !Number.isFinite(expiresOn)) return null;
    return { accessToken: parsed.secret, email, expiresOn };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Get a valid OWA access token for `email` (or the only OWA account if omitted).
 *
 * Resolution order: in-memory cache → disk cache → scrape MSAL cache from the
 * live OWA tab → (if stale) reload the tab and re-scrape.
 */
export async function getOwaToken(email?: string): Promise<OwaToken> {
  const key = email?.toLowerCase();

  // 1. memory
  if (key && isFresh(memCache.get(key))) return memCache.get(key)!;

  // 2. disk
  const disk = await loadDiskCache();
  if (key && isFresh(disk[key])) {
    memCache.set(key, disk[key]!);
    return disk[key]!;
  }
  // Single-session fallback. The OWA piggyback rides ONE signed-in browser
  // session, but callers identify the mailbox by its SMTP address
  // (--account ehu@law.virginia.edu) while the token is keyed by the UPN from
  // its `upn` claim (vwh7mb@lawschool.virginia.edu). When the requested key
  // doesn't match, reuse the single fresh cached token rather than needlessly
  // re-scraping CDP every call (or hanging on a wedged tab). Only when exactly
  // one fresh token exists — with several we can't safely guess which mailbox.
  const freshTokens = Object.values(disk).filter(isFresh);
  if (freshTokens.length === 1) {
    const only = freshTokens[0]!;
    memCache.set(only.email.toLowerCase(), only);
    if (key) {
      // Alias the requested address to this token so the next call hits directly.
      disk[key] = only;
      memCache.set(key, only);
      await saveDiskCache(disk).catch(() => {});
    }
    return only;
  }

  // 3. scrape the live OWA session
  const host = getCDPHost();
  const ports = cdpPortCandidates();
  let target: OwaCdpTarget | null = null;
  let usedPort = 0;
  for (const port of ports) {
    target = await findOwaTarget(host, port);
    if (target) {
      usedPort = port;
      break;
    }
  }
  if (!target) {
    throw new Error(
      "No Outlook Web tab found on the CDP browser. Open https://outlook.office.com " +
        "in the debugging browser (port 9222) and sign in, then retry."
    );
  }

  let tok = await scrapeToken(host, usedPort, target, false);
  // 4. stale or missing → reload the tab to force a silent re-mint, re-scrape
  if (!isFresh(tok ?? undefined)) {
    tok = await scrapeToken(host, usedPort, target, true);
  }
  if (!isFresh(tok ?? undefined)) {
    throw new Error(
      "Outlook Web session token is missing or expired. Open/refresh Outlook Web in " +
        "the browser (sign in if prompted), then retry."
    );
  }

  const token = tok!;
  memCache.set(token.email.toLowerCase(), token);
  disk[token.email.toLowerCase()] = token;
  // Also store under the requested address (SMTP) so later lookups by --account
  // hit the disk cache directly instead of re-scraping (UPN != SMTP).
  if (key && key !== token.email.toLowerCase()) {
    memCache.set(key, token);
    disk[key] = token;
  }
  await saveDiskCache(disk).catch(() => {});
  return token;
}

/** Clear the in-memory token cache. Tests only (disk cache is separate). */
export function clearOwaMemCacheForTest(): void {
  memCache.clear();
}

/** List OWA account emails known to the broker (from disk cache). */
export async function listOwaAccounts(): Promise<string[]> {
  const disk = await loadDiskCache();
  return Object.values(disk).map((t) => t.email);
}
