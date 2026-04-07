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
 * Get CDP port from environment or default to 9250.
 * Note: 9250 is used as the default — Chrome is launched with --remote-debugging-port=9250
 * to avoid conflicts with VS Code / Cursor which bind 9222 for their Electron CDP.
 */
export function getCDPPort(): number {
  const envPort = process.env.CDP_PORT;
  return envPort ? parseInt(envPort, 10) : 9250;
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
    `Ensure Chrome is running with --remote-debugging-port=${port} and mail.superhuman.com is open.`
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

  // If an account email is provided, prefer the page whose URL contains that email.
  // Fall back to longest-URL heuristic if no match (e.g. tab not open for that account).
  let mainPage: any;
  if (accountEmail) {
    mainPage =
      superhumanPages.find((t: any) =>
        t.url.toLowerCase().includes(accountEmail.toLowerCase())
      ) ?? superhumanPages.sort((a: any, b: any) => b.url.length - a.url.length)[0];
  } else {
    superhumanPages.sort((a: any, b: any) => b.url.length - a.url.length);
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
 * Convert plain text to HTML paragraphs (returns as-is if already HTML)
 */
export function textToHtml(text: string): string {
  if (!text) return "";
  if (text.includes("<")) return text;

  // First unescape any literal \n sequences
  const unescaped = unescapeString(text);

  return `<p>${unescaped.replace(/\n/g, "</p><p>")}</p>`;
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
