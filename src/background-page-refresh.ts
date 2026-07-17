/**
 * Background-Page Token Refresh
 *
 * Refreshes Superhuman ID tokens and provider access tokens WITHOUT
 * navigating any visible UI. Connects to the Electron app's hidden
 * `background_page.html` target, finds the per-account iframes
 * (each named after a linked email), and calls
 * `window.background.di.get("credential").getIDTokenAsync()` and
 * `getAccessTokenAsync()` inside each iframe's execution context.
 *
 * This replaces the legacy navigation-based refresh
 * (`Page.navigate` → focus steal). The background_page and its iframes
 * are hidden Electron infrastructure — there is no Page to bring to
 * front, so focus stealing is structurally impossible.
 *
 * Discovered via CDP probing on 2026-05-22 — see CLAUDE.md "Iframe
 * Credential Refresh".
 */
import CDP from "chrome-remote-interface";
import { classifyTarget } from "./cdp-endpoint";
import { getCDPHost, getCDPPort } from "./superhuman-api";
import type { TokenInfo } from "./token-api";

/** A connection scoped to the Electron background_page. */
export interface BgPageConn {
  client: CDP.Client;
  /** Map of email → frame's default execution-context id. */
  contextByEmail: Map<string, number>;
  /** Map of email → iframe frameId (informational / for debug). */
  frameByEmail: Map<string, string>;
}

/**
 * Locate and connect to the Electron app's background_page target.
 * Returns null if the target isn't present (e.g. the Electron app isn't
 * running with --remote-debugging-port, or the user is hitting Chrome
 * instead).
 */
export async function connectToBackgroundPage(
  port = getCDPPort()
): Promise<BgPageConn | null> {
  const host = getCDPHost();
  let targets: any[];
  try {
    targets = await CDP.List({ host, port });
  } catch {
    return null;
  }

  // classifyTarget, not substrings: this function ATTACHES to the target and
  // runs credential-refresh JavaScript in its contexts, so
  // https://evil.example/superhuman/background_page.html satisfying the old
  // check was the forged-target class the classifier exists to prevent.
  const bgPage = targets.find((t: any) => classifyTarget(t) === "electron");
  if (!bgPage) return null;

  let client: CDP.Client;
  try {
    client = await CDP({ target: bgPage.id, host, port });
  } catch {
    return null;
  }

  const { Page, Runtime } = client;
  await Page.enable();

  // Subscribe to executionContextCreated BEFORE Runtime.enable so we
  // receive the replay of existing contexts. CDP replays current
  // contexts on enable.
  const contexts: Array<{
    id: number;
    auxData?: { frameId?: string; isDefault?: boolean };
  }> = [];
  const onCtxCreated = (e: any) => contexts.push(e.context);
  client.on("Runtime.executionContextCreated", onCtxCreated);

  await Runtime.enable();
  // Give CDP a brief moment to replay all existing contexts.
  await new Promise((r) => setTimeout(r, 250));

  (client as unknown as {
    off(event: string, cb: (...args: any[]) => void): void;
  }).off("Runtime.executionContextCreated", onCtxCreated);

  // Walk frame tree to map email → frameId.
  const tree = await Page.getFrameTree();
  const frameByEmail = new Map<string, string>();
  for (const child of tree.frameTree.childFrames || []) {
    const name = child.frame.name;
    const url = child.frame.url;
    // Per-account iframes are named after the email and load superhuman.html.
    if (name && name.includes("@") && url.includes("superhuman.html")) {
      frameByEmail.set(name, child.frame.id);
    }
  }

  // Match each frame to its default execution context.
  const contextByEmail = new Map<string, number>();
  for (const [email, frameId] of frameByEmail) {
    const ctx = contexts.find(
      (c) => c.auxData?.frameId === frameId && c.auxData?.isDefault,
    );
    if (ctx) contextByEmail.set(email, ctx.id);
  }

  return { client, contextByEmail, frameByEmail };
}

export async function disconnectBackgroundPage(conn: BgPageConn): Promise<void> {
  try {
    await conn.client.close();
  } catch {
    // ignore
  }
}

/** Decode a JWT and return its payload (or null on failure). */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const [, payloadB64] = jwt.split(".");
    if (!payloadB64) return null;
    const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Extract a fresh TokenInfo from a single iframe's execution context.
 * Calls getIDTokenAsync() + getAccessTokenAsync() on the per-account
 * Credential, plus reads userId / userPrefix / deviceId from the
 * AccountBackground.
 */
export async function extractTokenFromIframe(
  conn: BgPageConn,
  email: string,
): Promise<TokenInfo | null> {
  const contextId = conn.contextByEmail.get(email);
  if (contextId === undefined) return null;

  const r = await conn.client.Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const bg = window.background;
          if (!bg) return { error: "no window.background" };
          const cred = bg.di?.get?.("credential");
          if (!cred) return { error: "no credential" };

          const idToken = await cred.getIDTokenAsync();
          const accessToken = await cred.getAccessTokenAsync();
          const authData = cred._authData || {};

          // userExternalId / userPrefix — settings live behind DI in the
          // iframe context (bg.di.get("settings")._cache.userId), unlike
          // the visible page where they live at GoogleAccount.labels._settings.
          let userExternalId = null;
          let userPrefix = null;
          try {
            const settings = bg.di?.get?.("settings");
            const uid = settings?._cache?.userId;
            if (uid) {
              userExternalId = uid;
              const s = String(uid).replace("user_", "");
              if (s.length >= 11) userPrefix = s.substring(7, 11);
            }
          } catch {}

          let deviceId = null;
          try {
            deviceId = bg?.device?.id || bg?.di?.get?.("device")?.id || null;
          } catch {}

          return {
            idToken,
            accessToken,
            email: bg?.emailAddress || authData.emailAddress || null,
            isMicrosoft: cred.provider === "microsoft",
            provider: cred.provider,
            authDataExpires: authData.expires || null,
            userId: bg.labels?._user?._id || authData.userId || null,
            userExternalId,
            userPrefix,
            deviceId,
          };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
    contextId,
  });

  const v = r.result.value as
    | {
        error?: string;
        idToken?: string;
        accessToken?: string;
        email?: string | null;
        isMicrosoft?: boolean;
        provider?: string;
        authDataExpires?: number | null;
        userId?: string | null;
        userExternalId?: string | null;
        userPrefix?: string | null;
        deviceId?: string | null;
      }
    | null;

  if (!v || v.error || !v.idToken || !v.accessToken) return null;

  // Decode idToken expiry from JWT.
  const idPayload = decodeJwtPayload(v.idToken);
  const idExpires =
    typeof idPayload?.exp === "number" ? idPayload.exp * 1000 : v.authDataExpires ?? Date.now() + 3600_000;

  // Decode accessToken expiry too (works for MS JWT; opaque for Google
  // — fall back to authData.expires).
  const accessPayload = decodeJwtPayload(v.accessToken);
  const accessExpires =
    typeof accessPayload?.exp === "number"
      ? accessPayload.exp * 1000
      : v.authDataExpires ?? idExpires;

  return {
    email: v.email || email,
    accessToken: v.accessToken,
    expires: accessExpires,
    isMicrosoft: !!v.isMicrosoft,
    userId: v.userId ?? undefined,
    idToken: v.idToken,
    idTokenExpires: idExpires,
    userPrefix: v.userPrefix ?? undefined,
    userExternalId: v.userExternalId ?? undefined,
    deviceId: v.deviceId ?? undefined,
    superhumanToken: {
      token: v.idToken,
      expires: idExpires,
    },
  };
}

/**
 * Refresh ALL accounts visible in the background_page in one CDP
 * connection. Returns the list of refreshed TokenInfo values; callers
 * are responsible for persisting them.
 *
 * @param emails - Optional filter; only refresh these emails. If
 *   undefined, refresh every account exposed by the background_page.
 */
export async function refreshAllViaBackgroundPage(
  emails?: string[],
  port?: number,
): Promise<TokenInfo[] | null> {
  const conn = await connectToBackgroundPage(port);
  if (!conn) return null;
  try {
    const wanted =
      emails && emails.length > 0
        ? emails.filter((e) => conn.contextByEmail.has(e))
        : Array.from(conn.contextByEmail.keys());
    const results: TokenInfo[] = [];
    for (const email of wanted) {
      const token = await extractTokenFromIframe(conn, email);
      if (token) results.push(token);
    }
    return results;
  } finally {
    await disconnectBackgroundPage(conn);
  }
}

/**
 * Refresh a single account via the background_page iframe path.
 * Returns null if the background_page is unreachable or the account
 * iframe isn't loaded — caller should fall back to the legacy
 * navigation-based refresh.
 */
export async function refreshOneViaBackgroundPage(
  email: string,
  port?: number,
): Promise<TokenInfo | null> {
  const all = await refreshAllViaBackgroundPage([email], port);
  return all && all[0] ? all[0] : null;
}
