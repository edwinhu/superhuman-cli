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
function getCDPHost(): string {
  return process.env.CDP_HOST || process.env.HOST_IP || "localhost";
}

/**
 * Check if Superhuman is running with CDP enabled
 */
export async function isSuperhmanRunning(port = 9333): Promise<boolean> {
  try {
    const host = getCDPHost();
    const targets = await CDP.List({ host, port });
    return targets.some(t => t.url.includes("mail.superhuman.com"));
  } catch {
    return false;
  }
}

/**
 * Launch Superhuman with remote debugging enabled.
 * Skips launch when CDP_HOST is set (remote/container environment).
 */
export async function launchSuperhuman(port = 9333): Promise<boolean> {
  // Check if already running (works for both local and remote)
  if (await isSuperhmanRunning(port)) {
    return true;
  }

  // If CDP_HOST is set, we're connecting to a remote instance — don't try to launch locally
  const host = getCDPHost();
  if (host !== "localhost") {
    console.error(`Superhuman not reachable at ${host}:${port}. Ensure it is running on the host with --remote-debugging-port=${port}`);
    return false;
  }

  const appPath = "/Applications/Superhuman.app/Contents/MacOS/Superhuman";

  // Launch in background with CDP enabled
  console.log("Launching Superhuman with remote debugging...");
  try {
    // Use Bun's shell to launch in background
    Bun.spawn([appPath, `--remote-debugging-port=${port}`], {
      stdout: "ignore",
      stderr: "ignore",
    });

    // Wait for Superhuman to be ready (up to 30 seconds)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await isSuperhmanRunning(port)) {
        console.log("Superhuman is ready");
        // Give it a bit more time to fully initialize
        await new Promise(r => setTimeout(r, 2000));
        return true;
      }
    }
    console.error("Timeout waiting for Superhuman to start");
    return false;
  } catch (e) {
    console.error("Failed to launch Superhuman:", (e as Error).message);
    return false;
  }
}

/**
 * Ensure Superhuman is running, launching it if necessary
 */
export async function ensureSuperhuman(port = 9333): Promise<boolean> {
  if (await isSuperhmanRunning(port)) {
    return true;
  }
  return launchSuperhuman(port);
}

/**
 * Find and connect to the Superhuman main page via CDP
 */
export async function connectToSuperhuman(
  port = 9333,
  autoLaunch = true
): Promise<SuperhumanConnection | null> {
  const host = getCDPHost();

  // Auto-launch if not running
  if (autoLaunch && !(await isSuperhmanRunning(port))) {
    const launched = await launchSuperhuman(port);
    if (!launched) {
      return null;
    }
  }

  const targets = await CDP.List({ host, port });

  const mainPage = targets.find(
    (t) =>
      t.url.includes("mail.superhuman.com") &&
      !t.url.includes("background") &&
      !t.url.includes("serviceworker") &&
      t.type === "page"
  );

  if (!mainPage) {
    console.error("Could not find Superhuman main page");
    return null;
  }

  const client = await CDP({ target: mainPage.id, host, port });

  // Enable Page domain for navigation events
  await client.Page.enable();

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
