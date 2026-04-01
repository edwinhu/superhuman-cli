/**
 * Labels Module
 *
 * Functions for managing email labels/folders.
 * Routes to Superhuman portal RPC (SuperhumanProvider).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";

export interface Label {
  id: string;
  name: string;
  type?: string;
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
 * List all starred threads
 *
 * @param provider - The connection provider
 * @param limit - Maximum number of threads to return (default: 50)
 * @returns Array of starred threads with their IDs
 */
export async function listStarred(
  provider: ConnectionProvider,
  limit: number = 50
): Promise<Array<{ id: string }>> {
  if (provider instanceof SuperhumanProvider) {
    if (!provider.hasPortal()) {
      throw new Error(
        "Starred listing requires running Superhuman app (portal RPC). " +
          "Run 'superhuman account auth' with the app open."
      );
    }
    const result = await provider.portalInvoke("threadInternal", "listAsync", [
      "STARRED",
      { limit, query: "" },
    ]);
    if (!Array.isArray(result)) return [];
    return result.map((item: any) => ({
      id: item.id || item.threadId || "",
    }));
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}
