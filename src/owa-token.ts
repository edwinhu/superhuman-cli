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

export interface OwaToken {
  accessToken: string;
  /** Account UPN / email, decoded from the token's `upn` claim. */
  email: string;
  /** Expiry as ms epoch. */
  expiresOn: number;
}

const memCache = new Map<string, OwaToken>();

function cacheFile(): string {
  return join(homedir(), ".config", "superhuman-cli", "owa-tokens.json");
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
  await fs.mkdir(join(homedir(), ".config", "superhuman-cli"), { recursive: true });
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
    targets = (await CDP.List({ host, port })) as any[];
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
  const client = await CDP({ target: target.id, host, port });
  try {
    if (reload) {
      await client.Page.enable();
      await client.Page.reload({ ignoreCache: false });
      await new Promise((r) => setTimeout(r, RELOAD_SETTLE_MS));
    }
    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression: READ_MSAL_EXPR,
      returnByValue: true,
    });
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
  if (!key) {
    const fresh = Object.values(disk).find(isFresh);
    if (fresh) {
      memCache.set(fresh.email.toLowerCase(), fresh);
      return fresh;
    }
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
  await saveDiskCache(disk).catch(() => {});
  return token;
}

/** List OWA account emails known to the broker (from disk cache). */
export async function listOwaAccounts(): Promise<string[]> {
  const disk = await loadDiskCache();
  return Object.values(disk).map((t) => t.email);
}
