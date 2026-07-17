/**
 * CDP Endpoint Discovery
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELIBERATELY NEAR-IDENTICAL to src/cdp-endpoint.ts in morgen-cli.
 * Only the PRODUCT BLOCK below differs. Keep it that way: both CLIs face the
 * same problem, and one flow you can learn once is worth more than two clever
 * ones. If you fix a bug here, fix it there.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Both products ship two deployments, and they are DIFFERENT CDP ENDPOINTS —
 * not different tabs on one endpoint:
 *
 *   1. the Electron desktop app  — macOS; listens on its own debug port
 *   2. Chrome/Chromium           — the web app; listens on the browser's port
 *
 * So: look for the Electron app first, then fall back to Chrome/Chromium.
 *
 * Getting this wrong is not theoretical. The sibling CLI hardcoded a single port
 * and never probed, so on Linux — where the desktop app does not exist and the
 * web app runs in Chromium on 9222 — every command failed with a bare
 * ECONNREFUSED unless the user knew to set CDP_PORT by hand.
 *
 * Ports (all overridable, see cdpPortCandidates):
 *   CDP_PORT           pin to one port (still listed; no other candidate tried)
 *   ELECTRON_CDP_PORT  the desktop app's port      (default below)
 *   CHROME_CDP_PORT    Chrome/Chromium's port      (default below)
 */

import CDP from "chrome-remote-interface";

// ─── PRODUCT BLOCK — the only part that differs from the sibling CLI ─────────

/** Human name, for error text. */
const PRODUCT = "Superhuman";

/**
 * The desktop app's debug port.
 *
 * What the `com.user.superhuman-cdp` LaunchAgent passes via
 * `--remote-debugging-port=9252`, and the only target exposing
 * `background_page.html` for the Electron refresh path.
 */
const DEFAULT_ELECTRON_PORT = 9252;

/** Chrome/Chromium's debug port, where the extension runs. */
const DEFAULT_CHROME_PORT = 9222;

/**
 * Is this target the product's Electron desktop app?
 *
 * The desktop app is the one exposing background_page.html; the Chrome
 * extension has no background_page at all. That, not a URL scheme, is what
 * distinguishes the deployments here.
 *
 * The host must still be ours. Electron ranks FIRST, so a false positive does
 * not merely add noise — it beats the genuine tab and gets credential-reading
 * code pointed at the impostor. A bare substring test accepted
 * https://evil.example/superhuman/background_page.html; the sibling CLI had the
 * same hole with /morgen/i and it ranked an attacker page ahead of the real one.
 *
 * file:// is allowed because a packaged app can serve background_page.html from
 * its install dir; forging that needs local filesystem access, by which point
 * the credential store is already readable.
 */
function isElectronTarget(url: string): boolean {
  if (!url.includes("background_page.html")) return false;

  // The desktop app serves its background page over its OWN scheme:
  //   superhuman-app://superhuman.com/background_page.html
  // Requiring http(s) rejected it outright — discovery skipped a healthy
  // Electron endpoint and desktop token refresh broke. Nothing but the app can
  // register this scheme, so an exact host+path check is the identity.
  let u: URL | null = null;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === `${ELECTRON_SCHEME}:`) {
    return (
      u.hostname.toLowerCase() === "superhuman.com" &&
      u.pathname === "/background_page.html"
    );
  }

  // A packaged build may serve it from its install dir; forging file:// needs
  // local filesystem access, by which point the credential store is readable.
  if (u.protocol === "file:") return /superhuman/i.test(url);

  // Otherwise the host must genuinely be the web app's, not merely the apex
  // domain: hostMatches(url, "superhuman.com") also accepted
  // accounts.superhuman.com/background_page.html. Electron ranks FIRST, so an
  // impostor here beats the real mail tab and gets the credential read
  // pointed at it — the same app-vs-domain distinction isWebTarget makes.
  return hostMatches(url, "mail.superhuman.com");
}

/**
 * Is this target the product's web app in a browser?
 *
 * The APP, not the domain. hostMatches("superhuman.com") is the right IDENTITY
 * check and the wrong ROLE check: it also accepts accounts.superhuman.com/login
 * and superhuman.com/blog. The code this replaced required mail.superhuman.com,
 * so widening it regressed the auth path — connectToSuperhumanChrome picks the
 * FIRST match, and the sign-in flow is exactly what leaves accounts.* open;
 * connectToSuperhuman sorts by URL length, and a marketing slug outruns an inbox.
 * Both then attach and run app-globals code in a page that has none.
 */
function isWebTarget(url: string): boolean {
  return hostMatches(url, "mail.superhuman.com");
}

/** Command that starts the desktop app with CDP, per platform. */
function electronLaunchHint(port: number, platform: string = process.platform): string {
  const bin =
    platform === "darwin"
      ? "/Applications/Superhuman.app/Contents/MacOS/Superhuman"
      : platform === "win32"
        ? "%LOCALAPPDATA%\\Programs\\Superhuman\\Superhuman.exe"
        : "superhuman"; // Linux: no desktop app ships today; the extension is the route
  return `${bin} --remote-debugging-port=${port}`;
}

/** The desktop app's own URL scheme — nothing else can register it. */
const ELECTRON_SCHEME = "superhuman-app";

/** Where the web app lives, for error text. */
const WEB_APP_URL = "https://mail.superhuman.com";

// ─── END PRODUCT BLOCK — everything below is identical across both CLIs ──────

export type ConnectionSource = "electron" | "chrome";

const DEFAULT_CDP_TIMEOUT_MS = 10_000;
/** setTimeout's 32-bit ceiling; beyond this it silently clamps to 1ms. */
export const MAX_CDP_TIMEOUT_MS = 2_147_483_647;

/**
 * Upper bound on a single CDP round-trip.
 *
 * Resolved at call time, not import time: a module-level const captures the env
 * before a test (or a caller) can set it.
 *
 * Validated rather than trusted. parseInt("garbage") is NaN and
 * setTimeout(fn, NaN) fires immediately; anything past the 32-bit ceiling is
 * clamped to 1ms. Either would make every call "time out" instantly with a
 * misleading message — the exact failure this guard exists to prevent.
 */
export function cdpTimeoutMs(): number {
  const raw = process.env.CDP_TIMEOUT_MS;
  if (!raw) return DEFAULT_CDP_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > MAX_CDP_TIMEOUT_MS) return DEFAULT_CDP_TIMEOUT_MS;
  return n;
}

/** Reject rather than wait forever — an unbounded CDP wait hangs the CLI silently. */
export function withTimeout<T>(p: Promise<T>, what: string, ms = cdpTimeoutMs()): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms — is the ${PRODUCT} tab responsive?`)),
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

/**
 * Does `url`'s HOSTNAME equal `domain`, or is it a subdomain of it?
 *
 * Never a substring test. `includes("morgen.so")` also matches
 * https://morgen.so.evil.example/ and https://evil.example/?next=morgen.so — and
 * discovery hands the winning target to code that runs credential-reading
 * JavaScript in it, so a forged identity is not cosmetic.
 */
export function hostMatches(url: string, domain: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;

  // Canonicalize before comparing. A fully qualified name carries a root dot —
  // "web.morgen.so." is the SAME DNS name as "web.morgen.so", and the WHATWG
  // parser preserves it. Rejecting it would exclude a genuine logged-in tab and
  // report "no target": a false negative here breaks auth outright, which is
  // worse than the substring hole this function replaced.
  const canon = (h: string) => h.toLowerCase().replace(/\.$/, "");
  const h = canon(u.hostname);
  const d = canon(domain);

  // An empty host, or a leading empty label (".morgen.so"), is not a real name.
  if (!h || !d || h.startsWith(".")) return false;

  // Note: userinfo cannot fool this — new URL("https://morgen.so@evil.example/")
  // has hostname "evil.example", and a port lives outside hostname.
  return h === d || h.endsWith(`.${d}`);
}

/** Read a positive integer port from the environment, or undefined. */
function envPort(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

/**
 * CDP endpoints to probe, in preference order: the desktop app, then the browser.
 *
 * An explicit CDP_PORT pins the list to that one port: if the user names a port,
 * probing past it would be second-guessing them. It does NOT skip discovery —
 * that port is still listed to find targets on it, so a firewalled host costs
 * one cdpTimeoutMs before failing. Naming a port is not the same as promising
 * something is there.
 */
export function cdpPortCandidates(): number[] {
  const explicit = envPort("CDP_PORT");
  if (explicit) return [explicit];
  return [
    envPort("ELECTRON_CDP_PORT") ?? DEFAULT_ELECTRON_PORT,
    envPort("CHROME_CDP_PORT") ?? DEFAULT_CHROME_PORT,
  ];
}

export function getCDPHost(): string {
  return process.env.CDP_HOST || process.env.HOST_IP || "localhost";
}

/** Classify a CDP target as the desktop app, the web app, or neither. */
export function classifyTarget(t: any): ConnectionSource | null {
  if (t?.type !== "page") return null;
  const url: string | undefined = t.url;
  if (!url) return null;
  if (isElectronTarget(url)) return "electron";
  if (isWebTarget(url)) return "chrome";
  return null;
}

/**
 * Rank every viable target, best first: the desktop app before the web app.
 *
 * Every one, not just the best. A CDP command routed through a page goes through
 * its renderer, and a busy renderer never answers — measured, 4 of 8 live page
 * targets were wedged at one point, and which ones drift over time. Committing
 * to a single target lets one wedged tab fail a refresh another target could
 * have served.
 */
export function rankTargets<T>(targets: T[]): Array<{ source: ConnectionSource; target: T }> {
  const ranked: Array<{ source: ConnectionSource; target: T }> = [];
  for (const source of ["electron", "chrome"] as const) {
    for (const target of targets) {
      if (classifyTarget(target) === source) ranked.push({ source, target });
    }
  }
  return ranked;
}

/** Error text naming both routes — either satisfies the CLI, and only one exists per platform. */
export function noTargetHint(ports: number[], platform: string = process.platform): string {
  return (
    `No ${PRODUCT} target found (probed port${ports.length > 1 ? "s" : ""} ${ports.join(", ")}).\n` +
    "Start either route (quit the app first if already open, so the debug port takes effect):\n" +
    `  Desktop app: ${electronLaunchHint(envPort("ELECTRON_CDP_PORT") ?? DEFAULT_ELECTRON_PORT, platform)}\n` +
    `  Web app:     open ${WEB_APP_URL} in a browser started with --remote-debugging-port=${
      envPort("CHROME_CDP_PORT") ?? DEFAULT_CHROME_PORT
    }`
  );
}

/** A discovered endpoint: the port, and the targets it is serving. */
export interface Endpoint {
  port: number;
  targets: any[];
}

/**
 * The PORT is cached for the process lifetime; the targets never are.
 *
 * Probing costs a round-trip per candidate, and the port will not move under a
 * running CLI. Targets will: tabs open and close constantly, so a cached target
 * list is stale the moment it is taken.
 */
let discoveredPort: number | null = null;

/** Reset the discovery cache. Tests only. */
export function resetEndpointCache(): void {
  discoveredPort = null;
}

/**
 * Find the CDP endpoint serving the product: the desktop app first, then the browser.
 *
 * Returns the first candidate port that has any viable target. A port that is
 * listening but serving something else (a headless Chrome for another tool, say)
 * is skipped rather than accepted — reachable is not the same as ours.
 *
 * Targets are always listed fresh, even on the cached-port path.
 */
export async function discoverEndpoint(remaining?: () => number): Promise<Endpoint> {
  const host = getCDPHost();
  // Every List is bounded by the SMALLER of one round-trip and whatever the
  // caller has left. Without the caller's budget, discovery hands each probe a
  // fresh full timeout and can outlast the very deadline the caller started
  // before calling us — leaving zero time to attach to the target it just found.
  const budget = () =>
    remaining ? Math.min(remaining(), cdpTimeoutMs()) : cdpTimeoutMs();

  // A cached port is a hint, not a verdict. The app can move between
  // deployments inside one process — quit Electron on its port, open the web
  // app in Chrome — and a long-lived caller (the MCP server) would otherwise
  // fail forever against a port that is now dead, or worse, one some other
  // service has since bound.
  let skip: number | null = null;
  if (discoveredPort !== null) {
    const port = discoveredPort;
    try {
      const targets = await withTimeout(
        CDP.List({ host, port }) as Promise<any[]>,
        `listing targets on port ${port}`,
        budget()
      );
      if (rankTargets(targets).length > 0) return { port, targets };
      // Listed fine, but nothing of ours is there any more — re-listing it
      // below would just repeat that answer, so skip it.
      skip = port;
    } catch {
      // A transient error (EPIPE, a blip) is NOT evidence the port is wrong, so
      // it stays a candidate: skipping it here failed the whole call while the
      // port was healthy a moment later.
    }
    discoveredPort = null;
  }

  const candidates = cdpPortCandidates();
  for (const port of candidates) {
    if (port === skip) continue;
    if (remaining && remaining() <= 0) break;
    let targets: any[];
    try {
      targets = await withTimeout(
        CDP.List({ host, port }) as Promise<any[]>,
        `listing targets on port ${port}`,
        budget()
      );
    } catch {
      continue; // not listening, or not answering — try the next candidate
    }
    if (rankTargets(targets).length > 0) {
      discoveredPort = port;
      return { port, targets };
    }
  }

  throw new Error(noTargetHint(candidates));
}
