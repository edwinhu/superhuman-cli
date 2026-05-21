/**
 * Labels Module
 *
 * Functions for managing email labels/folders.
 * Routes to Superhuman portal RPC (SuperhumanProvider).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";
import { listInboxFromDB } from "./sqlite-search";

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
  provider: ConnectionProvider,
  threadId: string,
  labelId: string
): Promise<LabelResult> {
  if (provider instanceof SuperhumanProvider) {
    if (!provider.hasPortal()) {
      return { success: false, error: "Requires running Superhuman app with CDP connection for label operations" };
    }
    try {
      await provider.portalInvoke("threadInternal", "modifyLabels", [
        threadId,
        { addLabelIds: [labelId], removeLabelIds: [] },
      ]);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Remove a label from a thread (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to remove the label from
 * @param labelId - The label ID to remove
 * @returns Result with success status
 */
export async function removeLabel(
  provider: ConnectionProvider,
  threadId: string,
  labelId: string
): Promise<LabelResult> {
  if (provider instanceof SuperhumanProvider) {
    if (!provider.hasPortal()) {
      return { success: false, error: "Requires running Superhuman app with CDP connection for label operations" };
    }
    try {
      await provider.portalInvoke("threadInternal", "modifyLabels", [
        threadId,
        { addLabelIds: [], removeLabelIds: [labelId] },
      ]);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Star a thread (adds STARRED label)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to star
 * @returns Result with success status
 */
export async function starThread(
  provider: ConnectionProvider,
  threadId: string
): Promise<LabelResult> {
  if (provider instanceof SuperhumanProvider) {
    if (!provider.hasPortal()) {
      return { success: false, error: "Requires running Superhuman app with CDP connection for star operations" };
    }
    try {
      await provider.portalInvoke("threadInternal", "modifyLabels", [
        threadId,
        { addLabelIds: ["STARRED"], removeLabelIds: [] },
      ]);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Unstar a thread (removes STARRED label)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to unstar
 * @returns Result with success status
 */
export async function unstarThread(
  provider: ConnectionProvider,
  threadId: string
): Promise<LabelResult> {
  if (provider instanceof SuperhumanProvider) {
    if (!provider.hasPortal()) {
      return { success: false, error: "Requires running Superhuman app with CDP connection for star operations" };
    }
    try {
      await provider.portalInvoke("threadInternal", "modifyLabels", [
        threadId,
        { addLabelIds: [], removeLabelIds: ["STARRED"] },
      ]);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
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
