/**
 * Read Status Module
 *
 * Functions for marking email threads as read or unread via direct Gmail/MS Graph API.
 * Supports both Microsoft/Outlook accounts (via MS Graph) and Gmail accounts (via Gmail API).
 */

import type { SuperhumanConnection } from "./superhuman-api";
import {
  type TokenInfo,
  getToken,
  modifyThreadLabels,
  updateMessage,
  getConversationMessageIds,
} from "./token-api";
import { listAccounts } from "./accounts";

export interface ReadStatusResult {
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
 * Mark a thread as read (server-persisted)
 *
 * For Microsoft accounts: Updates message isRead property via MS Graph API
 * For Gmail accounts: Removes UNREAD label via Gmail API
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to mark as read
 * @returns Result with success status
 */
export async function markAsRead(
  conn: SuperhumanConnection,
  threadId: string
): Promise<ReadStatusResult> {
  try {
    const token = await getCurrentToken(conn);

    if (token.isMicrosoft) {
      // Microsoft: Update isRead property on all messages in conversation
      const messageIds = await getConversationMessageIds(token, threadId);

      if (messageIds.length === 0) {
        return { success: false, error: "No messages found in conversation" };
      }

      // Mark each message as read
      for (const msgId of messageIds) {
        await updateMessage(token, msgId, { isRead: true });
      }

      return { success: true };
    } else {
      // Gmail: Remove UNREAD label
      const success = await modifyThreadLabels(token, threadId, [], ["UNREAD"]);
      return { success };
    }
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

/**
 * Mark a thread as unread (server-persisted)
 *
 * For Microsoft accounts: Updates message isRead property via MS Graph API
 * For Gmail accounts: Adds UNREAD label via Gmail API
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to mark as unread
 * @returns Result with success status
 */
export async function markAsUnread(
  conn: SuperhumanConnection,
  threadId: string
): Promise<ReadStatusResult> {
  try {
    const token = await getCurrentToken(conn);

    if (token.isMicrosoft) {
      // Microsoft: Update isRead property on all messages in conversation
      const messageIds = await getConversationMessageIds(token, threadId);

      if (messageIds.length === 0) {
        return { success: false, error: "No messages found in conversation" };
      }

      // Mark each message as unread
      for (const msgId of messageIds) {
        await updateMessage(token, msgId, { isRead: false });
      }

      return { success: true };
    } else {
      // Gmail: Add UNREAD label
      const success = await modifyThreadLabels(token, threadId, ["UNREAD"], []);
      return { success };
    }
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}
