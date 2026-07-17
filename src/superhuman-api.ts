/**
 * Superhuman Internal API Wrapper
 *
 * Provides programmatic access to Superhuman's internal APIs via Chrome DevTools Protocol (CDP).
 * Used for auth token extraction and connection management.
 */

import CDP from "chrome-remote-interface";
import { cdpPortCandidates, classifyTarget, discoverEndpoint, noTargetHint } from "./cdp-endpoint";

export interface SuperhumanConnection {
  client: CDP.Client;
  Runtime: CDP.Client["Runtime"];
  Input: CDP.Client["Input"];
  Network: CDP.Client["Network"];
  Page: CDP.Client["Page"];
}

/**
 * Get CDP host from environment or default to localhost
 */
export function getCDPHost(): string {
  return process.env.CDP_HOST || process.env.HOST_IP || "localhost";
}

/**
 * Get CDP port from CDP_PORT, or the static 9252 default.
 *
 * Prefer discoverSuperhumanPort() — this is the last-resort fallback, not a
 * probe. 9252 is the desktop app's port (what the `com.user.superhuman-cdp`
 * LaunchAgent passes), so on a Chrome-extension deployment this default is
 * simply wrong; only discovery finds the browser.
 */
export function getCDPPort(): number {
  const envPort = process.env.CDP_PORT;
  return envPort ? parseInt(envPort, 10) : 9252;
}

/**
 * Resolve the CDP port that actually hosts a Superhuman target.
 *
 * An explicit `CDP_PORT` wins. Otherwise probe the desktop app's port, then the
 * browser's — see cdp-endpoint.ts, which owns the candidates, the overrides and
 * the caching.
 *
 * Reads use local SQLite and don't need this; it matters for CDP paths —
 * chiefly token refresh — which failed when the app ran on a port the caller
 * did not name.
 */
export async function discoverSuperhumanPort(): Promise<number> {
  // Delegates to the shared discovery so there is exactly ONE implementation of
  // "find the endpoint": same candidates, same ELECTRON_CDP_PORT/CHROME_CDP_PORT
  // overrides, same skip-a-port-serving-something-else rule.
  //
  // There used to be two. This one probed a fixed [9252, 9250, 9222] and ignored
  // the env overrides entirely, and because token-api's refresh paths call it
  // FIRST and thread the result into readSessionCookieHeader — which treats a
  // supplied port as authoritative — the legacy answer always won. With
  // CHROME_CDP_PORT=9333 and nothing on the fixed candidates, refresh passed
  // 9252, read no cookies, kept the stale token, and the 401 it exists to fix
  // came back.
  //
  // Falls back to getCDPPort() rather than throwing: callers rely on this
  // returning a port, and a bad port fails later with a better message than a
  // discovery exception here would give.
  try {
    return (await discoverEndpoint()).port;
  } catch {
    return getCDPPort();
  }
}


/**
 * Check if Superhuman is running with CDP enabled
 */
export async function isSuperhumanRunning(port = getCDPPort()): Promise<boolean> {
  try {
    const host = getCDPHost();
    const targets = await CDP.List({ host, port });
    // classifyTarget, not a substring: mail.superhuman.com.evil.example must
    // not make us report Superhuman as running.
    return targets.some((t: any) => classifyTarget(t) !== null);
  } catch {
    return false;
  }
}

/**
 * Check that Chrome is reachable with a Superhuman tab.
 * No longer launches Electron — Superhuman runs as a Chrome tab.
 */
export async function ensureSuperhuman(port = getCDPPort()): Promise<boolean> {
  if (await isSuperhumanRunning(port)) {
    return true;
  }
  const host = getCDPHost();
  console.error(`Superhuman not reachable at ${host}:${port}.\n` + noTargetHint(cdpPortCandidates()));
  return false;
}

/**
 * Find and connect to the Superhuman main page via CDP.
 *
 * @param port - CDP port
 * @param autoLaunch - Check that Chrome/Superhuman is reachable
 * @param accountEmail - Prefer the page belonging to this account (e.g. "user@gmail.com").
 *   When multiple Superhuman tabs are open (one per linked account), this ensures we
 *   connect to the right account's local SQLite / portal rather than whichever tab
 *   happens to have the longest URL.
 */
export async function connectToSuperhuman(
  port = getCDPPort(),
  autoLaunch = true,
  accountEmail?: string
): Promise<SuperhumanConnection | null> {
  const host = getCDPHost();

  // Check Chrome is reachable with Superhuman tab
  if (autoLaunch && !(await ensureSuperhuman(port))) {
    return null;
  }

  const targets = await CDP.List({ host, port });

  // Prefer the page with an account path (e.g., /user@example.com) over the root page
  const superhumanPages = targets.filter(
    (t: any) =>
      classifyTarget(t) === "chrome" &&
      !t.url.includes("background") &&
      !t.url.includes("serviceworker")
  );

  // Sort by URL length descending — pages with account paths are longer
  superhumanPages.sort((a: any, b: any) => b.url.length - a.url.length);

  // If an account email is provided, prefer the page whose URL contains that email.
  // Returns null if no matching tab is open — caller should fall back to token-only path.
  let mainPage: any;
  if (accountEmail) {
    // Match the account's PATH SEGMENT, not any occurrence of the address.
    // includes() let a different genuine Superhuman tab win whenever the email
    // appeared in its query or fragment — and the caller then runs credential and
    // account extraction in the wrong account's page.
    mainPage = superhumanPages.find((t: any) => urlHasAccountSegment(t.url, accountEmail)) ?? null;
    if (!mainPage) return null;
  } else {
    mainPage = superhumanPages[0];
  }

  if (!mainPage) {
    console.error("Could not find Superhuman main page");
    return null;
  }

  const client = await CDP({ target: mainPage.id, host, port });

  return {
    client,
    Runtime: client.Runtime,
    Input: client.Input,
    Network: client.Network,
    Page: client.Page,
  };
}

/** Does this URL address `email` as a path segment (not merely mention it)? */
function urlHasAccountSegment(url: string, email: string): boolean {
  try {
    const u = new URL(url);
    const want = email.toLowerCase();
    // Path only — never search/hash, which the caller does not control.
    return u.pathname
      .split("/")
      .some((seg) => decodeURIComponent(seg).toLowerCase() === want);
  } catch {
    return false;
  }
}

/**
 * Disconnect from Superhuman
 */
export async function disconnect(conn: SuperhumanConnection): Promise<void> {
  await conn.client.close();
}

// ============================================================================
// Chrome Extension Support
// ============================================================================

const SUPERHUMAN_EXTENSION_ID = "dcgcnpooblobhncpnddnhoendgbnglpn";

/**
 * Is this target the Superhuman extension's service worker?
 *
 * The ID must be the exact HOST of a chrome-extension: URL. A substring test
 * accepts any site serving a worker whose URL merely contains the ID — e.g.
 * https://evil.example/dcgcnpooblobhncpnddnhoendgbnglpn/sw.js — and both
 * extension paths then attach and run token/account extraction inside it.
 */
function isSuperhumanExtensionWorker(t: any): boolean {
  if (t?.type !== "service_worker" || !t.url) return false;
  try {
    const u = new URL(t.url);
    return u.protocol === "chrome-extension:" && u.hostname === SUPERHUMAN_EXTENSION_ID;
  } catch {
    return false;
  }
}

export interface ChromeExtConnection {
  swClient: CDP.Client;
  mainClient: CDP.Client;
}

/**
 * Find the Superhuman Chrome extension service worker target.
 */
export async function findChromeExtension(port: number): Promise<any | null> {
  try {
    const host = getCDPHost();
    const targets = await CDP.List({ host, port });
    return targets.find(isSuperhumanExtensionWorker) ?? null;
  } catch {
    return null;
  }
}

/**
 * Connect to Superhuman running as a Chrome extension.
 * Requires both the service worker (for account data) and main page (for navigation).
 */
export async function connectToSuperhumanChrome(
  port: number
): Promise<ChromeExtConnection | null> {
  try {
    const host = getCDPHost();
    const targets = await CDP.List({ host, port });

    const sw = targets.find(isSuperhumanExtensionWorker);
    // The page we attach to and run credential-reading code in — the one place
    // a forged host would do real damage. classifyTarget verifies the hostname.
    const mainPage = targets.find((t: any) => classifyTarget(t) === "chrome");

    if (!sw || !mainPage) return null;

    const swClient = await CDP({ target: sw.id, host, port });
    const mainClient = await CDP({ target: mainPage.id, host, port });
    await mainClient.Page.enable();

    return { swClient, mainClient };
  } catch {
    return null;
  }
}

/**
 * Disconnect from Chrome extension CDP clients.
 */
export async function disconnectChrome(
  conn: ChromeExtConnection
): Promise<void> {
  await conn.swClient.close();
  await conn.mainClient.close();
}

/**
 * Unescape literal escape sequences (like \n, \t) in a string
 */
export function unescapeString(text: string): string {
  if (!text) return text;
  return text.replace(/\\([ntr\\])/g, (match, char) => {
    switch (char) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      default:
        return char;
    }
  });
}

/**
 * Wrap bare http(s) URLs in plain text with clickable <a> anchors.
 *
 * Only operates on text known NOT to contain markup (callers gate on the
 * absence of "<"), so there is no risk of double-linkifying existing anchors.
 * Trailing sentence punctuation (.,;:!?) is left outside the link; closing
 * brackets/parens are deliberately NOT stripped so URLs that legitimately end
 * in them survive.
 */
export function linkifyUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<]+/g, (url) => {
    const trail = url.match(/[.,;:!?]+$/);
    const href = trail ? url.slice(0, -trail[0].length) : url;
    const tail = trail ? trail[0] : "";
    return `<a href="${href}">${href}</a>${tail}`;
  });
}

/**
 * Convert plain text to HTML paragraphs (returns as-is if already HTML).
 * Bare URLs in plain text are auto-linkified into clickable anchors so a
 * `--body "https://…"` becomes a real hyperlink, matching the desktop client.
 */
export function textToHtml(text: string): string {
  if (!text) return "";
  if (text.includes("<")) return text;

  // First unescape any literal \n sequences
  const unescaped = unescapeString(text);

  const linked = linkifyUrls(unescaped);

  return `<p>${linked.replace(/\n/g, "</p><p>")}</p>`;
}

/**
 * Convert HTML to readable plain text for terminal display.
 */
export function htmlToText(html: string): string {
  if (!html) return "";

  let text = html;

  // Block-level elements → newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<\/blockquote>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  // List items: add bullet
  text = text.replace(/<li[^>]*>/gi, "  • ");

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&#x27;/g, "'");
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));

  // Collapse excessive whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}
