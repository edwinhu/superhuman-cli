/**
 * Archive Module
 *
 * Functions for archiving and trashing email threads via direct Gmail/MS Graph API.
 * Supports both Microsoft/Outlook accounts (via MS Graph) and Gmail accounts (via Gmail API).
 */

import type { SuperhumanConnection } from "./superhuman-api";
import {
  type TokenInfo,
  getToken,
  modifyThreadLabels,
  moveMessageToFolder,
  getConversationMessageIds,
  getWellKnownFolder,
} from "./token-api";
import { listAccounts } from "./accounts";

export interface ArchiveResult {
  success: boolean;
  error?: string;
}

export interface DeleteResult {
  success: boolean;
  error?: string;
}

/**
 * Get token for the current account.
 */
async function getCurrentToken(conn: SuperhumanConnection): Promise<TokenInfo> {
  const accounts = await listAccounts(conn);
  const currentAccount = accounts.find((a) => a.isCurrent);

  if (!currentAccount) {
    throw new Error("No current account found");
  }

  return getToken(conn, currentAccount.email);
}

/**
 * Archive a thread by removing it from inbox (server-persisted)
 *
 * For Microsoft accounts: Moves messages to the Archive folder via MS Graph API
 * For Gmail accounts: Removes INBOX label via Gmail API
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to archive
 * @returns Result with success status
 */
export async function archiveThread(
  conn: SuperhumanConnection,
  threadId: string
): Promise<ArchiveResult> {
  try {
    const token = await getCurrentToken(conn);

    if (token.isMicrosoft) {
      // Microsoft: Move messages to Archive folder
      const archiveFolder = await getWellKnownFolder(token, "archive");

      if (!archiveFolder) {
        return { success: false, error: "Archive folder not found" };
      }

      const messageIds = await getConversationMessageIds(token, threadId);

      if (messageIds.length === 0) {
        return { success: false, error: "No messages found in conversation" };
      }

      // Move each message to archive
      for (const msgId of messageIds) {
        await moveMessageToFolder(token, msgId, archiveFolder.id);
      }

      return { success: true };
    } else {
      // Gmail: Remove INBOX label (archive = remove from inbox)
      const success = await modifyThreadLabels(token, threadId, [], ["INBOX"]);
      return { success };
    }
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

/**
 * Delete (trash) a thread (server-persisted)
 *
 * For Microsoft accounts: Moves messages to Deleted Items folder via MS Graph API
 * For Gmail accounts: Adds TRASH label and removes INBOX via Gmail API
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to delete
 * @returns Result with success status
 */
export async function deleteThread(
  conn: SuperhumanConnection,
  threadId: string
): Promise<DeleteResult> {
  try {
    const token = await getCurrentToken(conn);

    if (token.isMicrosoft) {
      // Microsoft: Move messages to Deleted Items folder
      const trashFolder = await getWellKnownFolder(token, "deleteditems");

      if (!trashFolder) {
        return { success: false, error: "Deleted Items folder not found" };
      }

      const messageIds = await getConversationMessageIds(token, threadId);

      if (messageIds.length === 0) {
        return { success: false, error: "No messages found in conversation" };
      }

      // Move each message to trash
      for (const msgId of messageIds) {
        await moveMessageToFolder(token, msgId, trashFolder.id);
      }

      return { success: true };
    } else {
      // Gmail: Add TRASH label and remove INBOX
      const success = await modifyThreadLabels(token, threadId, ["TRASH"], ["INBOX"]);
      return { success };
    }
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}
