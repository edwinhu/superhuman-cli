/**
 * Labels Module
 *
 * Functions for managing email labels/folders via direct Gmail/MS Graph API.
 * Supports both Microsoft/Outlook accounts (via MS Graph folders) and Gmail accounts (via Gmail labels).
 */

import type { SuperhumanConnection } from "./superhuman-api";
import {
  type TokenInfo,
  getToken,
  modifyThreadLabels,
  updateMessage,
  listLabelsDirect,
  searchGmailDirect,
  getConversationMessageIds,
} from "./token-api";
import { listAccounts } from "./accounts";

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
 * List all available labels/folders in the account
 *
 * @param conn - The Superhuman connection
 * @returns Array of labels with id and name
 */
export async function listLabels(conn: SuperhumanConnection): Promise<Label[]> {
  const token = await getCurrentToken(conn);
  return listLabelsDirect(token);
}

/**
 * Get labels for a specific thread
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to get labels for
 * @returns Array of labels on the thread
 */
export async function getThreadLabels(
  conn: SuperhumanConnection,
  threadId: string
): Promise<Label[]> {
  const token = await getCurrentToken(conn);

  // Get all labels to build name mapping
  const allLabels = await listLabelsDirect(token);
  const labelMap = new Map(allLabels.map((l) => [l.id, l]));

  if (token.isMicrosoft) {
    // For MS Graph, we need to get the message and check its folder
    const messageIds = await getConversationMessageIds(token, threadId);
    if (messageIds.length === 0) {
      return [];
    }

    // MS Graph messages have parentFolderId
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${messageIds[0]}?$select=parentFolderId`,
      {
        headers: { Authorization: `Bearer ${token.accessToken}` },
      }
    );

    if (!response.ok) {
      return [];
    }

    const msg = await response.json() as { parentFolderId?: string };
    const folderId = msg.parentFolderId;
    const folder = labelMap.get(folderId);

    return folder ? [folder] : [];
  } else {
    // Gmail: Get thread to get labelIds
    const response = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=minimal`,
      {
        headers: { Authorization: `Bearer ${token.accessToken}` },
      }
    );

    if (!response.ok) {
      return [];
    }

    const thread = await response.json() as { messages?: Array<{ labelIds?: string[] }> };
    const labelIds = thread.messages?.[0]?.labelIds || [];

    return labelIds.map((id: string) => labelMap.get(id) || { id, name: id });
  }
}

/**
 * Add a label to a thread (server-persisted)
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to add the label to
 * @param labelId - The label ID to add
 * @returns Result with success status
 */
export async function addLabel(
  conn: SuperhumanConnection,
  threadId: string,
  labelId: string
): Promise<LabelResult> {
  try {
    const token = await getCurrentToken(conn);

    if (token.isMicrosoft) {
      // Microsoft: Move messages to the folder (label = folder in MS)
      // This is complex because MS Graph doesn't have a direct "add label" concept
      // For folders, adding a label means moving to that folder
      return {
        success: false,
        error: "Adding labels to Microsoft accounts not yet supported via direct API. Use folders instead.",
      };
    } else {
      // Gmail: Add label via threads.modify
      const success = await modifyThreadLabels(token, threadId, [labelId], []);
      return { success };
    }
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

/**
 * Remove a label from a thread (server-persisted)
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to remove the label from
 * @param labelId - The label ID to remove
 * @returns Result with success status
 */
export async function removeLabel(
  conn: SuperhumanConnection,
  threadId: string,
  labelId: string
): Promise<LabelResult> {
  try {
    const token = await getCurrentToken(conn);

    if (token.isMicrosoft) {
      return {
        success: false,
        error: "Removing labels from Microsoft accounts not yet supported via direct API.",
      };
    } else {
      // Gmail: Remove label via threads.modify
      const success = await modifyThreadLabels(token, threadId, [], [labelId]);
      return { success };
    }
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

/**
 * Star a thread (adds STARRED label)
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to star
 * @returns Result with success status
 */
export async function starThread(
  conn: SuperhumanConnection,
  threadId: string
): Promise<LabelResult> {
  try {
    const token = await getCurrentToken(conn);

    if (token.isMicrosoft) {
      // Microsoft: Flag all messages in the conversation
      const messageIds = await getConversationMessageIds(token, threadId);

      if (messageIds.length === 0) {
        return { success: false, error: "No messages found in conversation" };
      }

      // Flag each message
      for (const msgId of messageIds) {
        await updateMessage(token, msgId, {
          flag: { flagStatus: "flagged" },
        });
      }

      return { success: true };
    } else {
      // Gmail: Add STARRED label
      const success = await modifyThreadLabels(token, threadId, ["STARRED"], []);
      return { success };
    }
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

/**
 * Unstar a thread (removes STARRED label)
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to unstar
 * @returns Result with success status
 */
export async function unstarThread(
  conn: SuperhumanConnection,
  threadId: string
): Promise<LabelResult> {
  try {
    const token = await getCurrentToken(conn);

    if (token.isMicrosoft) {
      // Microsoft: Unflag all messages in the conversation
      const messageIds = await getConversationMessageIds(token, threadId);

      if (messageIds.length === 0) {
        return { success: false, error: "No messages found in conversation" };
      }

      // Unflag each message
      for (const msgId of messageIds) {
        await updateMessage(token, msgId, {
          flag: { flagStatus: "notFlagged" },
        });
      }

      return { success: true };
    } else {
      // Gmail: Remove STARRED label
      const success = await modifyThreadLabels(token, threadId, [], ["STARRED"]);
      return { success };
    }
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

/**
 * List all starred threads
 *
 * @param conn - The Superhuman connection
 * @param limit - Maximum number of threads to return (default: 50)
 * @returns Array of starred threads with their IDs
 */
export async function listStarred(
  conn: SuperhumanConnection,
  limit: number = 50
): Promise<Array<{ id: string }>> {
  try {
    const token = await getCurrentToken(conn);

    if (token.isMicrosoft) {
      // MS Graph: Search for flagged messages
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages?$filter=flag/flagStatus eq 'flagged'&$top=${limit}&$select=conversationId`,
        {
          headers: { Authorization: `Bearer ${token.accessToken}` },
        }
      );

      if (!response.ok) {
        return [];
      }

      const result = await response.json() as { value?: Array<{ conversationId?: string }> };
      if (!result.value) {
        return [];
      }

      // Get unique conversation IDs
      const conversationIds = new Set<string>();
      for (const msg of result.value) {
        if (msg.conversationId) {
          conversationIds.add(msg.conversationId);
        }
      }

      return Array.from(conversationIds).map((id) => ({ id }));
    } else {
      // Gmail: Search for starred messages
      const threads = await searchGmailDirect(token, "is:starred", limit);
      return threads.map((t) => ({ id: t.id }));
    }
  } catch (e) {
    return [];
  }
}
