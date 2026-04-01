/**
 * Archive Module
 *
 * Functions for archiving and trashing email threads.
 * Routes to Superhuman portal RPC (SuperhumanProvider).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";

export interface ArchiveResult {
  success: boolean;
  error?: string;
}

export interface DeleteResult {
  success: boolean;
  error?: string;
}

/**
 * Archive a thread by removing it from inbox (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to archive
 * @returns Result with success status
 */
export async function archiveThread(
  provider: ConnectionProvider,
  threadId: string
): Promise<ArchiveResult> {
  if (provider instanceof SuperhumanProvider) {
    if (!provider.hasPortal()) {
      return { success: false, error: "Requires running Superhuman app with CDP connection for archive" };
    }
    try {
      await provider.portalInvoke("threadInternal", "modifyLabels", [
        threadId,
        { addLabelIds: [], removeLabelIds: ["INBOX"] },
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
 * Delete (trash) a thread (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to delete
 * @returns Result with success status
 */
export async function deleteThread(
  provider: ConnectionProvider,
  threadId: string
): Promise<DeleteResult> {
  if (provider instanceof SuperhumanProvider) {
    if (!provider.hasPortal()) {
      return { success: false, error: "Requires running Superhuman app with CDP connection for delete" };
    }
    try {
      await provider.portalInvoke("threadInternal", "modifyLabels", [
        threadId,
        { addLabelIds: ["TRASH"], removeLabelIds: [] },
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
