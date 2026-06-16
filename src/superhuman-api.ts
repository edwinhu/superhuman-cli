/**
 * Superhuman Internal API Wrapper
 *
 * Provides programmatic access to Superhuman's internal APIs via Chrome DevTools Protocol (CDP).
 * Used for auth token extraction and connection management.
 */

import CDP from "chrome-remote-interface";

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
 * Get CDP port from environment or default to 9252.
 * Note: 9252 is the port the Superhuman desktop (Electron) app listens on —
 * it's what the `com.user.superhuman-cdp` LaunchAgent passes via
 * `--remote-debugging-port=9252`, and the only target exposing
 * `background_page.html` for token refresh. (9250 was the old Chrome-tab-mode
 * default and is often occupied by an unrelated Chrome instance.)
 */
export function getCDPPort(): number {
  const envPort = process.env.CDP_PORT;
  return envPort ? parseInt(envPort, 10) : 9252;
}

/**
 * Candidate CDP ports to probe when CDP_PORT isn't explicitly set.
 * 9252 = the Superhuman desktop (Electron) app — the one exposing
 * `background_page.html`, so it's tried first; 9250 = legacy Chrome-tab mode
 * (extension service worker); 9222 = generic Chromium default.
 */
const CDP_PORT_CANDIDATES = [9252, 9250, 9222];

// Cache the discovered port for the process lifetime to avoid re-probing.
let discoveredPort: number | null = null;

/**
 * Resolve the CDP port that actually hosts a Superhuman target.
 *
 * An explicit `CDP_PORT` env var always wins. Otherwise probe the candidate
 * ports and prefer one exposing the Electron `background_page.html` (required
 * for silent token refresh); fall back to any port with a `mail.superhuman.com`
 * page, then to the static default. Result is cached.
 *
 * Reads use local SQLite and don't need this; it matters for CDP paths —
 * chiefly token refresh — which previously failed when the app ran on a
 * non-default port (e.g. the desktop app on 9252).
 */
export async function discoverSuperhumanPort(): Promise<number> {
  if (process.env.CDP_PORT) return parseInt(process.env.CDP_PORT, 10);
  if (discoveredPort !== null) return discoveredPort;

  const host = getCDPHost();
  let pageFallback: number | null = null;

  for (const port of CDP_PORT_CANDIDATES) {
    let targets: any[];
    try {
      targets = await CDP.List({ host, port });
    } catch {
      continue; // port not listening
    }
    const hasBgPage = targets.some(
      (t: any) =>
        t.type === "page" &&
        t.url.includes("background_page.html") &&
        t.url.includes("superhuman")
    );
    if (hasBgPage) {
      discoveredPort = port;
      return port;
    }
    if (
      pageFallback === null &&
      targets.some(
        (t: any) => t.type === "page" && t.url.includes("mail.superhuman.com")
      )
    ) {
      pageFallback = port;
    }
  }

  discoveredPort = pageFallback ?? getCDPPort();
  return discoveredPort;
}

/**
 * Check if Superhuman is running with CDP enabled
 */
export async function isSuperhumanRunning(port = getCDPPort()): Promise<boolean> {
  try {
    const host = getCDPHost();
    const targets = await CDP.List({ host, port });
    return targets.some(t => t.url.includes("mail.superhuman.com"));
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
  console.error(
    `Superhuman not reachable at ${host}:${port}.\n` +
    `Probed ports ${CDP_PORT_CANDIDATES.join(", ")} for a Superhuman target and found none.\n` +
    `Launch the desktop app with remote debugging, e.g.:\n` +
    `  /Applications/Superhuman.app/Contents/MacOS/Superhuman --remote-debugging-port=9252\n` +
    `If it is running on a different port, pass --port <n> or set CDP_PORT.`
  );
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
      t.url.includes("mail.superhuman.com") &&
      !t.url.includes("background") &&
      !t.url.includes("serviceworker") &&
      t.type === "page"
  );

  // Sort by URL length descending — pages with account paths are longer
  superhumanPages.sort((a: any, b: any) => b.url.length - a.url.length);

  // If an account email is provided, prefer the page whose URL contains that email.
  // Returns null if no matching tab is open — caller should fall back to token-only path.
  let mainPage: any;
  if (accountEmail) {
    mainPage = superhumanPages.find((t: any) =>
      t.url.toLowerCase().includes(accountEmail.toLowerCase())
    ) ?? null;
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
    return (
      targets.find(
        (t: any) =>
          t.url.includes(SUPERHUMAN_EXTENSION_ID) &&
          t.type === "service_worker"
      ) ?? null
    );
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

    const sw = targets.find(
      (t: any) =>
        t.url.includes(SUPERHUMAN_EXTENSION_ID) &&
        t.type === "service_worker"
    );
    const mainPage = targets.find(
      (t: any) =>
        t.url.includes("mail.superhuman.com") && t.type === "page"
    );

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
