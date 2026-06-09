/**
 * Archive Module
 *
 * Functions for archiving and trashing email threads. Token-direct: archive and
 * delete are just label writes (remove INBOX / add TRASH) via the Superhuman
 * backend — no running app required.
 */

import { modifyThreadLabels } from "./labels";
import type { TokenInfo } from "./token-api";

export interface ArchiveResult {
  success: boolean;
  error?: string;
}

export interface DeleteResult {
  success: boolean;
  error?: string;
}

/**
 * Archive a thread by removing it from the inbox (server-persisted).
 */
export async function archiveThread(
  token: TokenInfo,
  threadId: string
): Promise<ArchiveResult> {
  return modifyThreadLabels(token, threadId, [], ["INBOX"]);
}

/**
 * Delete (trash) a thread (server-persisted).
 */
export async function deleteThread(
  token: TokenInfo,
  threadId: string
): Promise<DeleteResult> {
  return modifyThreadLabels(token, threadId, ["TRASH"], []);
}
