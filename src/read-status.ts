/**
 * Read Status Module
 *
 * Mark email threads read/unread. Token-direct: read state is the UNREAD label,
 * written via the Superhuman backend — no running app required.
 */

import { modifyThreadLabels } from "./labels";
import type { TokenInfo } from "./token-api";

export interface ReadStatusResult {
  success: boolean;
  error?: string;
}

/**
 * Mark a thread as read (removes UNREAD label, server-persisted).
 */
export async function markAsRead(
  token: TokenInfo,
  threadId: string
): Promise<ReadStatusResult> {
  return modifyThreadLabels(token, threadId, [], ["UNREAD"]);
}

/**
 * Mark a thread as unread (adds UNREAD label, server-persisted).
 */
export async function markAsUnread(
  token: TokenInfo,
  threadId: string
): Promise<ReadStatusResult> {
  return modifyThreadLabels(token, threadId, ["UNREAD"], []);
}
