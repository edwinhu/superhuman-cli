/**
 * Archive Module
 *
 * Functions for archiving and trashing email threads via Superhuman's internal APIs.
 * Supports both Microsoft/Outlook accounts (via msgraph) and Gmail accounts (via gmail API).
 */

import type { SuperhumanConnection } from "./superhuman-api";

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
 * For Microsoft accounts: Moves messages to the Archive folder via msgraph API
 * For Gmail accounts: Removes INBOX label via gmail API
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to archive
 * @returns Result with success status
 */
export async function archiveThread(
  conn: SuperhumanConnection,
  threadId: string
): Promise<ArchiveResult> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const threadId = ${JSON.stringify(threadId)};
          const ga = window.GoogleAccount;
          const di = ga?.di;

          if (!di) {
            return { success: false, error: "DI container not found" };
          }

          // Get the thread from identity map
          const thread = ga?.threads?.identityMap?.get?.(threadId);
          if (!thread) {
            return { success: false, error: "Thread not found" };
          }

          const model = thread._threadModel;
          if (!model) {
            return { success: false, error: "Thread model not found" };
          }

          // Check if thread is in inbox (has INBOX label)
          if (!model.labelIds || !model.labelIds.includes('INBOX')) {
            // Thread already not in inbox - consider this a success
            return { success: true };
          }

          // Check if this is a Microsoft account
          const isMicrosoft = di.get?.('isMicrosoft');

          if (isMicrosoft) {
            // Microsoft account: Use msgraph.moveMessages to Archive folder
            const msgraph = di.get?.('msgraph');
            if (!msgraph) {
              return { success: false, error: "msgraph service not found" };
            }

            // Get message IDs from the thread model
            const messageIds = model.messageIds;
            if (!messageIds || messageIds.length === 0) {
              return { success: false, error: "No messages found in thread" };
            }

            // Get the Archive folder
            const folders = await msgraph.getAllFolders();
            const archiveFolder = folders?.find(f =>
              f.displayName?.toLowerCase() === 'archive'
            );

            if (!archiveFolder) {
              return { success: false, error: "Archive folder not found" };
            }

            // Build move requests - each message needs to be moved
            const moveRequests = messageIds.map(messageId => ({
              messageId: messageId,
              destinationFolderId: archiveFolder.id
            }));

            // Move messages to Archive folder
            await msgraph.moveMessages(moveRequests);
          } else {
            // Gmail account: Use gmail.changeLabelsPerThread to remove INBOX label
            const gmail = di.get?.('gmail');
            if (!gmail) {
              return { success: false, error: "gmail service not found" };
            }

            // For Gmail, archive simply removes the INBOX label
            // (email remains in "All Mail" and can be found via search)
            await gmail.changeLabelsPerThread(threadId, [], ['INBOX']);
          }

          // Update local state for immediate UI feedback
          model.labelIds = model.labelIds.filter(l => l !== 'INBOX');

          // Recalculate list IDs if available
          try {
            thread.recalculateListIds?.();
          } catch (e) {}

          // Remove from sorted inbox list
          const tls = window.ViewState?.threadListState;
          if (tls?._list?._sortedList?.sorted) {
            const sl = tls._list._sortedList;
            const idx = sl.sorted.findIndex(t => t.id === threadId);
            if (idx >= 0) {
              sl.sorted.splice(idx, 1);
            }
          }

          return { success: true };
        } catch (e) {
          return { success: false, error: e.message || "Unknown error" };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  const value = result.result.value as { success: boolean; error?: string } | null;
  return { success: value?.success ?? false, error: value?.error };
}

/**
 * Delete (trash) a thread (server-persisted)
 *
 * For Microsoft accounts: Moves messages to Deleted Items folder via msgraph API
 * For Gmail accounts: Adds TRASH label and removes INBOX via gmail API
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to delete
 * @returns Result with success status
 */
export async function deleteThread(
  conn: SuperhumanConnection,
  threadId: string
): Promise<DeleteResult> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const threadId = ${JSON.stringify(threadId)};
          const ga = window.GoogleAccount;
          const di = ga?.di;

          if (!di) {
            return { success: false, error: "DI container not found" };
          }

          // Get the thread from identity map
          const thread = ga?.threads?.identityMap?.get?.(threadId);
          if (!thread) {
            return { success: false, error: "Thread not found" };
          }

          const model = thread._threadModel;
          if (!model) {
            return { success: false, error: "Thread model not found" };
          }

          // Check if thread is already in trash
          if (model.labelIds && model.labelIds.includes('TRASH')) {
            // Thread already in trash - consider this a success
            return { success: true };
          }

          // Check if this is a Microsoft account
          const isMicrosoft = di.get?.('isMicrosoft');

          if (isMicrosoft) {
            // Microsoft account: Use msgraph.moveMessages to Deleted Items folder
            const msgraph = di.get?.('msgraph');
            if (!msgraph) {
              return { success: false, error: "msgraph service not found" };
            }

            // Get message IDs from the thread model
            const messageIds = model.messageIds;
            if (!messageIds || messageIds.length === 0) {
              return { success: false, error: "No messages found in thread" };
            }

            // Get the Deleted Items folder
            const folders = await msgraph.getAllFolders();
            const trashFolder = folders?.find(f =>
              f.displayName?.toLowerCase() === 'deleted items'
            );

            if (!trashFolder) {
              return { success: false, error: "Deleted Items folder not found" };
            }

            // Build move requests - each message needs to be moved
            const moveRequests = messageIds.map(messageId => ({
              messageId: messageId,
              destinationFolderId: trashFolder.id
            }));

            // Move messages to Deleted Items folder
            await msgraph.moveMessages(moveRequests);
          } else {
            // Gmail account: Use gmail.changeLabelsPerThread to add TRASH and remove INBOX
            const gmail = di.get?.('gmail');
            if (!gmail) {
              return { success: false, error: "gmail service not found" };
            }

            // Add TRASH label and remove INBOX
            await gmail.changeLabelsPerThread(threadId, ['TRASH'], ['INBOX']);
          }

          // Update local state for immediate UI feedback
          if (!model.labelIds.includes('TRASH')) {
            model.labelIds.push('TRASH');
          }
          model.labelIds = model.labelIds.filter(l => l !== 'INBOX');

          // Recalculate list IDs if available
          try {
            thread.recalculateListIds?.();
          } catch (e) {}

          // Remove from sorted inbox list
          const tls = window.ViewState?.threadListState;
          if (tls?._list?._sortedList?.sorted) {
            const sl = tls._list._sortedList;
            const idx = sl.sorted.findIndex(t => t.id === threadId);
            if (idx >= 0) {
              sl.sorted.splice(idx, 1);
            }
          }

          return { success: true };
        } catch (e) {
          return { success: false, error: e.message || "Unknown error" };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  const value = result.result.value as { success: boolean; error?: string } | null;
  return { success: value?.success ?? false, error: value?.error };
}
