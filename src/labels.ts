/**
 * Labels Module
 *
 * Functions for managing email labels/folders.
 * Routes to Superhuman portal RPC (SuperhumanProvider).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";
import { listInboxFromDB, readThreadFromDB } from "./sqlite-search";
import { refreshTokenViaCDP, type TokenInfo } from "./token-api";

/** Thrown by a provider call on HTTP 401 so the caller can refresh + retry once. */
class ProviderAuthError extends Error {}

/**
 * Add/remove labels on a thread (token-direct, no running app required). This is
 * the single primitive behind archive, delete, star, label add/remove, and mark
 * read/unread.
 *
 * **Why the provider API and not the Superhuman backend?** Reverse-engineering
 * the live desktop app (build 1041.0.9) — Network-monitoring the renderer while
 * toggling a star — showed Superhuman itself mutates per-thread labels by
 * calling the *provider* directly, NOT a `~backend` endpoint:
 *
 *   Gmail:     POST gmail.googleapis.com/gmail/v1/users/me/threads/{id}/modify
 *              body {addLabelIds, removeLabelIds}
 *   Microsoft: PATCH graph.microsoft.com/v1.0/me/messages/{id}  {isRead, flag, …}
 *              POST  graph.microsoft.com/v1.0/me/messages/{id}/move {destinationId}
 *
 * There is no Superhuman backend RPC for a single-thread Gmail/Outlook label
 * change — the app enqueues an offline "modifier" locally and flushes it to the
 * provider API (captured on the wire). `messages.modifyLabels` is for *shared
 * team* labels only; `relabels.create` is a heavyweight bulk-action (query +
 * splits + label metadata) used only above a selection threshold. The old
 * `userdata.writeMessage` → `threads/{id}/labels` write returned HTTP 400 (no
 * such backend write path) and the portal `threadInternal.modifyLabels` method
 * was removed from the app.
 *
 * This is therefore a confirmed provider-API exception, analogous to attachment
 * download (`attachments.ts`): it uses the stored OAuth `accessToken` from
 * tokens.json (the PROVIDER token, not `superhumanToken`) — the same credential
 * Superhuman uses internally. On HTTP 401 the token is refreshed via CDP and the
 * call retried once.
 */
export async function modifyThreadLabels(
  token: TokenInfo,
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[]
): Promise<LabelResult> {
  if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
    return { success: true };
  }

  const attempt = async (tok: TokenInfo): Promise<LabelResult> => {
    const accessToken = tok.accessToken;
    if (!accessToken) {
      return {
        success: false,
        error: "No provider access token (run 'superhuman account auth')",
      };
    }
    if (tok.isMicrosoft) {
      return modifyThreadLabelsMsGraph(tok.email, threadId, addLabelIds, removeLabelIds, accessToken);
    }
    return modifyThreadLabelsGmail(threadId, addLabelIds, removeLabelIds, accessToken);
  };

  try {
    return await attempt(token);
  } catch (e: any) {
    if (!(e instanceof ProviderAuthError)) {
      return { success: false, error: e.message };
    }
    // 401 → refresh the provider OAuth token via CDP and retry exactly once.
    const refreshed = await refreshTokenViaCDP(token.email);
    if (!refreshed) {
      return { success: false, error: "Authentication failed (run 'superhuman account auth')" };
    }
    try {
      return await attempt(refreshed);
    } catch (e2: any) {
      if (e2 instanceof ProviderAuthError) {
        return { success: false, error: "Authentication failed (token refresh did not clear 401)" };
      }
      return { success: false, error: e2.message };
    }
  }
}

/**
 * Gmail: a single POST to the thread-modify endpoint. Matches the app's
 * `changeLabelsPerThread`, which uses this for *every* label change — including
 * adding TRASH (delete) and removing INBOX (archive); there is no separate
 * trash/untrash call.
 */
async function modifyThreadLabelsGmail(
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
  accessToken: string,
  isRetry = false
): Promise<LabelResult> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(
    threadId
  )}/modify`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
  if (resp.status === 401) throw new ProviderAuthError("Gmail 401");
  if (resp.status === 404 && !isRetry) {
    // Superhuman-local thread ids aren't always Gmail thread ids: the SQLite
    // cache does its own thread grouping, and the id it reports is often a
    // *message* id (inbox listings use the latest message id; merged threads
    // can use an id Gmail has never seen as a thread). messages.get accepts a
    // message id and returns the authoritative threadId — resolve, retry once.
    const realId = await resolveGmailThreadId(threadId, accessToken);
    if (realId && realId !== threadId) {
      return modifyThreadLabelsGmail(realId, addLabelIds, removeLabelIds, accessToken, true);
    }
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { success: false, error: `Gmail thread modify failed: HTTP ${resp.status} ${body.slice(0, 300)}` };
  }
  return { success: true };
}

/**
 * Resolve a (possibly message-level or Superhuman-local) id to the Gmail
 * server thread id via messages.get. Returns null when Gmail doesn't know
 * the id as a message either.
 */
async function resolveGmailThreadId(
  id: string,
  accessToken: string
): Promise<string | null> {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=minimal`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (resp.status === 401) throw new ProviderAuthError("Gmail 401");
  if (!resp.ok) return null;
  const data = (await resp.json().catch(() => null)) as { threadId?: string } | null;
  return data?.threadId ?? null;
}

/**
 * Microsoft/Outlook has no labels. The app translates label changes to per-
 * message MS Graph mutations (see `_computeMicrosoftMessageUpdates` /
 * `_isMicrosoftMessageMoved` in the app bundle):
 *   - UNREAD/STARRED/importance → PATCH /me/messages/{id}
 *   - INBOX/TRASH (a folder move) → POST /me/messages/{id}/move {destinationId}
 * A "thread" is a conversation, and these are per-MESSAGE, so the change is
 * applied to every message id in the thread (resolved from the local SQLite
 * cache, same as snooze).
 */
async function modifyThreadLabelsMsGraph(
  email: string,
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
  accessToken: string
): Promise<LabelResult> {
  const messageIds = resolveMsMessageIds(email, threadId);

  const patch = computeMicrosoftMessageUpdates(addLabelIds, removeLabelIds);
  const moveDest = computeMicrosoftMoveDestination(addLabelIds, removeLabelIds);
  const hasPatch = Object.keys(patch).length > 0;

  for (const id of messageIds) {
    if (hasPatch) {
      const resp = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }
      );
      if (resp.status === 401) throw new ProviderAuthError("MS Graph 401");
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { success: false, error: `MS Graph message update failed: HTTP ${resp.status} ${body.slice(0, 300)}` };
      }
    }
    if (moveDest) {
      const resp = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}/move`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ destinationId: moveDest }),
        }
      );
      if (resp.status === 401) throw new ProviderAuthError("MS Graph 401");
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { success: false, error: `MS Graph message move failed: HTTP ${resp.status} ${body.slice(0, 300)}` };
      }
    }
  }
  return { success: true };
}

/**
 * Resolve every message id in a thread from the local SQLite cache so the
 * change applies to the whole conversation (MS Graph mutations are per-message).
 * Falls back to the threadId itself — MS inbox threadIds are message ids — when
 * the thread isn't cached locally, so the operation still affects at least the
 * representative message rather than failing outright.
 */
function resolveMsMessageIds(email: string, threadId: string): string[] {
  let json: Record<string, unknown> | null = null;
  try {
    json = readThreadFromDB(email, threadId);
  } catch {
    json = null;
  }
  if (!json) return [threadId];
  const raw: any = json;
  const messages: any[] = Array.isArray(raw.messages)
    ? raw.messages
    : typeof raw.messages === "object" && raw.messages !== null
    ? Object.values(raw.messages)
    : [];
  const ids = messages.map((m: any) => m?.id || m?.message_id).filter(Boolean) as string[];
  return ids.length > 0 ? ids : [threadId];
}

/** Map label add/remove sets to an MS Graph message PATCH body. */
export function computeMicrosoftMessageUpdates(
  addLabelIds: string[],
  removeLabelIds: string[]
): { isRead?: boolean; flag?: { flagStatus: string }; inferenceClassification?: string } {
  const w: { isRead?: boolean; flag?: { flagStatus: string }; inferenceClassification?: string } = {};
  if (removeLabelIds.includes("UNREAD")) w.isRead = true;
  else if (addLabelIds.includes("UNREAD")) w.isRead = false;
  if (removeLabelIds.includes("STARRED")) w.flag = { flagStatus: "complete" };
  else if (addLabelIds.includes("STARRED")) w.flag = { flagStatus: "flagged" };
  if (addLabelIds.includes("SH_IMPORTANT")) w.inferenceClassification = "focused";
  else if (addLabelIds.includes("SH_OTHER")) w.inferenceClassification = "other";
  return w;
}

/** Map an INBOX/TRASH label change to an MS Graph well-known destination folder. */
export function computeMicrosoftMoveDestination(
  addLabelIds: string[],
  removeLabelIds: string[]
): string | null {
  if (addLabelIds.includes("TRASH")) return "deleteditems";
  if (removeLabelIds.includes("INBOX")) return "archive";
  if (addLabelIds.includes("INBOX")) return "inbox";
  return null;
}

export interface Label {
  id: string;
  name: string;
  type?: string;
}

export interface StarredThread {
  id: string;
  subject?: string;
  from?: { email: string; name: string };
  date?: string;
  snippet?: string;
  labelIds?: string[];
}

function parseFromField(from: any): { email: string; name: string } {
  if (!from) return { email: "", name: "" };
  if (typeof from === "string") {
    const m = from.match(/^(.+?)\s*<(.+?)>$/);
    if (m) return { name: m[1].trim(), email: m[2].trim() };
    return { email: from, name: from };
  }
  return {
    email: from.email || from.attributes?.email || "",
    name: from.name || "",
  };
}

export interface LabelResult {
  success: boolean;
  error?: string;
}

/**
 * List all available labels/folders in the account
 *
 * @param provider - The connection provider
 * @returns Array of labels with id and name
 */
export async function listLabels(provider: ConnectionProvider): Promise<Label[]> {
  if (provider instanceof SuperhumanProvider) {
    if (!provider.hasPortal()) {
      throw new Error(
        "Label listing requires running Superhuman app (portal RPC). " +
          "Run 'superhuman account auth' with the app open."
      );
    }
    // Use runtimeEvaluate to read labels from the in-app labels cache.
    // window.GoogleAccount.labels._labels is a Map<string, LabelObject>.
    const result = await provider.runtimeEvaluate(`
      (() => {
        try {
          const labels = window.GoogleAccount?.labels?._labels;
          if (!labels) return null;
          const entries = typeof labels.entries === 'function'
            ? Array.from(labels.entries())
            : Object.entries(labels);
          return entries.map(([id, label]) => ({
            id,
            name: label.name || label.displayName || id,
            type: label.type || (id === id.toUpperCase() ? "system" : "user"),
          }));
        } catch (e) {
          return null;
        }
      })()
    `);
    if (!result || !Array.isArray(result)) return [];
    return result;
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Get labels for a specific thread
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to get labels for
 * @returns Array of labels on the thread
 */
export async function getThreadLabels(
  _provider: ConnectionProvider,
  _threadId: string
): Promise<Label[]> {
  // TODO: Implement via SuperhumanProvider
  throw new Error("Not yet implemented. Run 'superhuman account auth' to authenticate.");
}

/**
 * Add a label to a thread (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to add the label to
 * @param labelId - The label ID to add
 * @returns Result with success status
 */
export async function addLabel(
  token: TokenInfo,
  threadId: string,
  labelId: string
): Promise<LabelResult> {
  return modifyThreadLabels(token, threadId, [labelId], []);
}

/**
 * Remove a label from a thread (server-persisted, token-direct).
 */
export async function removeLabel(
  token: TokenInfo,
  threadId: string,
  labelId: string
): Promise<LabelResult> {
  return modifyThreadLabels(token, threadId, [], [labelId]);
}

/**
 * Star a thread (adds STARRED label, token-direct).
 */
export async function starThread(token: TokenInfo, threadId: string): Promise<LabelResult> {
  return modifyThreadLabels(token, threadId, ["STARRED"], []);
}

/**
 * Unstar a thread (removes STARRED label, token-direct).
 */
export async function unstarThread(token: TokenInfo, threadId: string): Promise<LabelResult> {
  return modifyThreadLabels(token, threadId, [], ["STARRED"]);
}

/**
 * List all starred threads.
 *
 * Reads the local SQLite cache (OPFS blob) first — STARRED is just another
 * list_id in the threads.list_ids table, and the cache already has full
 * subject/from/date metadata. Falls back to portal RPC `threadInternal.listAsync`
 * only when SQLite is unavailable (no blob found, no app installed).
 *
 * The previous implementation called `portalInvoke("threadInternal","listAsync",["STARRED",...])`
 * but: (a) the portal returns a `{threads:[...]}` wrapper that was rejected by
 * the `Array.isArray` shape check, and (b) the cache is authoritative anyway.
 *
 * @param provider - The connection provider
 * @param limit - Maximum number of threads to return (default: 50)
 * @returns Array of starred threads with id and (when available) subject/from/date.
 */
export async function listStarred(
  provider: ConnectionProvider,
  limit: number = 50
): Promise<StarredThread[]> {
  if (!(provider instanceof SuperhumanProvider)) {
    throw new Error(
      "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
    );
  }

  // 1. SQLite path (preferred): STARRED is a list_id with full message metadata.
  try {
    const accountEmail = await provider.getCurrentEmail();
    if (accountEmail) {
      const rows = listInboxFromDB(accountEmail, "STARRED", limit);
      if (rows && rows.length > 0) {
        return rows
          .map((row): StarredThread | null => {
            let json: any;
            try {
              json = typeof row.json === "string" ? JSON.parse(row.json) : row.json;
            } catch {
              return { id: row.threadId, labelIds: row.labelIds };
            }
            const messages: any[] = Array.isArray(json.messages)
              ? json.messages
              : typeof json.messages === "object" && json.messages !== null
              ? Object.values(json.messages)
              : [];
            if (messages.length === 0) {
              return { id: row.threadId, labelIds: row.labelIds };
            }
            messages.sort(
              (a: any, b: any) =>
                new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
            );
            const latest = messages[messages.length - 1];
            return {
              id: latest.id || row.threadId,
              subject: latest.subject || "",
              from: parseFromField(latest.from),
              date: latest.date || "",
              snippet: latest.snippet || "",
              labelIds: row.labelIds,
            };
          })
          .filter((t): t is StarredThread => t !== null);
      }
      // rows === [] means SQLite was readable but no STARRED threads exist.
      // Treat as authoritative and return empty rather than falling back.
      if (rows && rows.length === 0) return [];
      // rows === null means the OPFS blob wasn't found; fall through.
    }
  } catch (e) {
    // Surface SQLite errors but still attempt portal fallback.
    console.error(
      `[listStarred] SQLite lookup failed: ${(e as Error).message}`
    );
  }

  // 2. Portal RPC fallback (requires CDP-connected app).
  if (!provider.hasPortal()) {
    throw new Error(
      "Starred listing requires either a local Superhuman SQLite cache " +
        "or a running Superhuman app (portal RPC). " +
        "Run 'superhuman account auth' with the app open to populate the cache."
    );
  }
  const result = await provider.portalInvoke("threadInternal", "listAsync", [
    "STARRED",
    { limit, query: "" },
  ]);
  const rawThreads: any[] = Array.isArray(result)
    ? result
    : Array.isArray(result?.threads)
    ? result.threads
    : [];
  return rawThreads.map((item: any): StarredThread => {
    if (item.json) {
      const json = item.json;
      const threadId: string = json.id || item.id || item.threadId || "";
      const messages: any[] = Array.isArray(json.messages)
        ? json.messages
        : typeof json.messages === "object" && json.messages !== null
        ? Object.values(json.messages)
        : [];
      if (messages.length === 0) {
        return { id: threadId, labelIds: item.listIds || [] };
      }
      messages.sort(
        (a: any, b: any) =>
          new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
      );
      const latest = messages[messages.length - 1];
      return {
        id: latest.id || threadId,
        subject: latest.subject || "",
        from: parseFromField(latest.from),
        date: latest.date || "",
        snippet: latest.snippet || "",
        labelIds: item.listIds || latest.labelIds || [],
      };
    }
    return { id: item.id || item.threadId || "" };
  });
}
