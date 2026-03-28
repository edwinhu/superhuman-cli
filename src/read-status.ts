/**
 * Read Status Module
 *
 * Functions for marking email threads as read or unread via direct Gmail/MS Graph API.
 * Supports both Microsoft/Outlook accounts (via MS Graph) and Gmail accounts (via Gmail API).
 */

import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider } from "./mcp-provider";
import {
  modifyThreadLabels,
  updateMessage,
  getConversationMessageIds,
} from "./token-api";

export interface ReadStatusResult {
  success: boolean;
  error?: string;
}

/**
 * Mark a thread as read (server-persisted)
 *
 * For Microsoft accounts: Updates message isRead property via MS Graph API
 * For Gmail accounts: Removes UNREAD label via Gmail API
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to mark as read
 * @returns Result with success status
 */
export async function markAsRead(
  provider: ConnectionProvider,
  threadId: string
): Promise<ReadStatusResult> {
  // MCP: update_email with Read action
  if (provider instanceof McpConnectionProvider) {
    try {
      await provider.callTool("update_email", {
        thread_id: threadId,
        action: "mark_read",
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  try {
    const token = await provider.getToken();

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
 * @param provider - The connection provider
 * @param threadId - The thread ID to mark as unread
 * @returns Result with success status
 */
export async function markAsUnread(
  provider: ConnectionProvider,
  threadId: string
): Promise<ReadStatusResult> {
  // MCP: update_email with Unread action
  if (provider instanceof McpConnectionProvider) {
    try {
      await provider.callTool("update_email", {
        thread_id: threadId,
        action: "mark_unread",
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  try {
    const token = await provider.getToken();

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
