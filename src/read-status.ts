/**
 * Read Status Module
 *
 * Functions for marking email threads as read or unread.
 * Routes to Superhuman portal RPC (SuperhumanProvider).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";

export interface ReadStatusResult {
  success: boolean;
  error?: string;
}

/**
 * Mark a thread as read (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to mark as read
 * @returns Result with success status
 */
export async function markAsRead(
  provider: ConnectionProvider,
  threadId: string
): Promise<ReadStatusResult> {
  if (provider instanceof SuperhumanProvider) {
    if (!provider.hasPortal()) {
      return { success: false, error: "Requires running Superhuman app with CDP connection for read status" };
    }
    try {
      await provider.portalInvoke("threadInternal", "modifyLabels", [
        threadId,
        { addLabelIds: [], removeLabelIds: ["UNREAD"] },
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
 * Mark a thread as unread (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to mark as unread
 * @returns Result with success status
 */
export async function markAsUnread(
  provider: ConnectionProvider,
  threadId: string
): Promise<ReadStatusResult> {
  if (provider instanceof SuperhumanProvider) {
    if (!provider.hasPortal()) {
      return { success: false, error: "Requires running Superhuman app with CDP connection for read status" };
    }
    try {
      await provider.portalInvoke("threadInternal", "modifyLabels", [
        threadId,
        { addLabelIds: ["UNREAD"], removeLabelIds: [] },
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
