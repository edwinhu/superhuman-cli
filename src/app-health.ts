/**
 * CDP Health Check + Background Relaunch
 *
 * Superhuman's Electron app binds its remote-debugging port
 * (`--remote-debugging-port=9252`) at launch, but the DevTools listener
 * has been observed to tear down later in a long-lived session (most
 * likely on a sleep/wake cycle or an auto-update event). Once it's gone,
 * it never comes back on its own, so every CDP-dependent operation —
 * chiefly silent token refresh via the background_page — fails and the
 * CLI degrades to the legacy focus-stealing navigation path.
 *
 * IMPORTANT: `open -gja Superhuman` on an ALREADY-RUNNING app is a no-op
 * for the port (macOS just re-activates the existing instance). The only
 * way to rebind the port is to fully quit the app and launch it fresh.
 * The relaunch uses `open -gja` (`-g` = don't foreground, `-j` = hidden)
 * so restoring the port never itself steals focus.
 *
 * See CLAUDE.md "Iframe Credential Refresh" and the 2026-07-06
 * investigation of recurring focus stealing.
 */
import CDP from "chrome-remote-interface";
import { classifyTarget } from "./cdp-endpoint";
import { getCDPHost, getCDPPort } from "./superhuman-api";

const APP_PATH = "/Applications/Superhuman.app";
/** Matches the main Superhuman binary and its helper processes. */
const PROC_PATTERN = "MacOS/Superhuman";

/**
 * True if a Superhuman `background_page.html` target is reachable on
 * `port` — the precondition for silent (non-focus-stealing) token
 * refresh. A bare open port isn't enough; an unrelated Chromium (Dia,
 * Obsidian, …) can answer on a candidate port without exposing the
 * Superhuman background page.
 */
export async function isBackgroundPageReachable(
  port = getCDPPort(),
): Promise<boolean> {
  try {
    const targets = await CDP.List({ host: getCDPHost(), port });
    // classifyTarget, not substrings. This module having its own matcher is how
    // the classifier's superhuman-app:// blind spot stayed hidden: app-health
    // kept reporting the desktop app healthy while discovery could not see it.
    return targets.some((t: any) => classifyTarget(t) === "electron");
  } catch {
    return false;
  }
}

/** True if any Superhuman process is currently running. */
async function isAppRunning(): Promise<boolean> {
  const res = await Bun.$`pgrep -f ${PROC_PATTERN}`.quiet().nothrow();
  return res.exitCode === 0 && res.stdout.toString().trim().length > 0;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RelaunchResult {
  /** Whether the background_page became reachable after relaunch. */
  healthy: boolean;
  /** True if we actually quit + relaunched (vs. it was already healthy). */
  relaunched: boolean;
  /** How long we waited for the port to come back, ms. */
  waitedMs: number;
  detail: string;
}

/**
 * Quit any running Superhuman instance and relaunch it in the background
 * with remote debugging, then wait until its background_page is reachable.
 *
 * This CLOSES the user's current Superhuman window — only call it when the
 * CDP port is confirmed dead (the app is already in a degraded, focus-
 * stealing state) or from an explicit `doctor` invocation.
 */
export async function relaunchSuperhumanForCDP(
  port = getCDPPort(),
  timeoutMs = 20_000,
): Promise<RelaunchResult> {
  const start = Date.now();

  // 1. Graceful quit first (lets the app flush drafts), then force-kill any
  //    survivors so the port is guaranteed released before relaunch.
  await Bun.$`osascript -e ${'tell application "Superhuman" to quit'}`
    .quiet()
    .nothrow();
  for (let i = 0; i < 8 && (await isAppRunning()); i++) {
    await sleep(500);
  }
  if (await isAppRunning()) {
    await Bun.$`pkill -f ${PROC_PATTERN}`.quiet().nothrow();
    await sleep(1000);
  }

  // 2. Relaunch in the background (no focus steal) with the debug port.
  await Bun.$`/usr/bin/open -gja ${APP_PATH} --args ${`--remote-debugging-port=${port}`}`
    .quiet()
    .nothrow();

  // 3. Poll until the background_page target appears (or timeout).
  while (Date.now() - start < timeoutMs) {
    if (await isBackgroundPageReachable(port)) {
      return {
        healthy: true,
        relaunched: true,
        waitedMs: Date.now() - start,
        detail: `background_page reachable on port ${port}`,
      };
    }
    await sleep(1000);
  }

  return {
    healthy: false,
    relaunched: true,
    waitedMs: Date.now() - start,
    detail: `background_page still unreachable on port ${port} after ${Math.round(
      (Date.now() - start) / 1000,
    )}s`,
  };
}

/**
 * Ensure the silent-refresh CDP path is healthy; relaunch if not.
 *
 * Safe by default: if the background_page is already reachable this is a
 * cheap no-op. If it's dead, it relaunches ONLY when `allowRelaunch` is
 * true (the caller has decided closing/reopening the app is acceptable).
 * Otherwise it just reports the unhealthy state.
 */
export async function ensureCDPHealthy(opts?: {
  port?: number;
  allowRelaunch?: boolean;
  timeoutMs?: number;
}): Promise<RelaunchResult> {
  const port = opts?.port ?? getCDPPort();
  if (await isBackgroundPageReachable(port)) {
    return {
      healthy: true,
      relaunched: false,
      waitedMs: 0,
      detail: `background_page already reachable on port ${port}`,
    };
  }
  if (!opts?.allowRelaunch) {
    return {
      healthy: false,
      relaunched: false,
      waitedMs: 0,
      detail: `background_page unreachable on port ${port} (relaunch not permitted)`,
    };
  }
  return relaunchSuperhumanForCDP(port, opts?.timeoutMs);
}
