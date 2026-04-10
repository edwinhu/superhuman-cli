/**
 * Read Status Module
 *
 * Functions for marking email threads as read or unread.
 * Routes to Superhuman portal RPC (SuperhumanProvider) with backend API fallback.
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";

export interface ReadStatusResult {
  success: boolean;
  error?: string;
}

/**
 * Modify labels on a thread via the backend writeMessage API.
 * Used as fallback when portal RPC is unavailable or fails.
 */
async function modifyLabelsBackend(
  provider: SuperhumanProvider,
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[]
): Promise<ReadStatusResult> {
  try {
    await provider.backendFetch("/v3/userdata.writeMessage", {
      method: "POST",
      body: JSON.stringify({
        writes: [
          {
            path: `threads/${threadId}/labels`,
            value: { addLabelIds, removeLabelIds },
          },
        ],
      }),
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Mark a thread as read (server-persisted)
 *
 * Tries portal RPC first (if available), then falls back to backend API.
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
    // Try portal first if available
    if (provider.hasPortal()) {
      try {
        await provider.portalInvoke("threadInternal", "modifyLabels", [
          threadId,
          { addLabelIds: [], removeLabelIds: ["UNREAD"] },
        ]);
        return { success: true };
      } catch (_portalErr: any) {
        // Portal failed — fall through to backend
      }
    }

    // Backend fallback
    return modifyLabelsBackend(provider, threadId, [], ["UNREAD"]);
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Mark a thread as unread (server-persisted)
 *
 * Tries portal RPC first (if available), then falls back to backend API.
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
    // Try portal first if available
    if (provider.hasPortal()) {
      try {
        await provider.portalInvoke("threadInternal", "modifyLabels", [
          threadId,
          { addLabelIds: ["UNREAD"], removeLabelIds: [] },
        ]);
        return { success: true };
      } catch (_portalErr: any) {
        // Portal failed — fall through to backend
      }
    }

    // Backend fallback
    return modifyLabelsBackend(provider, threadId, ["UNREAD"], []);
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}
