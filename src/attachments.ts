/**
 * Attachments Module
 *
 * Functions for listing and downloading attachments from Superhuman emails
 * via direct Gmail/MS Graph API.
 */

import type { SuperhumanConnection } from "./superhuman-api";
import {
  type TokenInfo,
  type AttachmentInfo,
  getToken,
  getThreadDirect,
  downloadAttachmentDirect,
} from "./token-api";
import { listAccounts } from "./accounts";

export interface Attachment {
  id: string;
  attachmentId: string;
  name: string;
  mimeType: string;
  extension: string;
  messageId: string;
  threadId: string;
  inline: boolean;
}

export interface AttachmentContent {
  data: string; // base64
  size: number;
}

export interface AddAttachmentResult {
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
 * Extract file extension from filename.
 */
function getExtension(filename: string): string {
  const parts = filename.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

/**
 * List all attachments from a thread
 */
export async function listAttachments(
  conn: SuperhumanConnection,
  threadId: string
): Promise<Attachment[]> {
  const token = await getCurrentToken(conn);
  const thread = await getThreadDirect(token, threadId);

  if (!thread) {
    return [];
  }

  const attachments: Attachment[] = [];

  for (const msg of thread.messages) {
    for (const att of msg.attachments) {
      attachments.push({
        id: att.id,
        attachmentId: att.attachmentId,
        name: att.filename,
        mimeType: att.mimeType,
        extension: getExtension(att.filename),
        messageId: att.messageId,
        threadId: threadId,
        inline: false, // Direct API doesn't easily distinguish inline
      });
    }
  }

  return attachments;
}

/**
 * Download attachment content as base64
 * Works for both Gmail and Microsoft accounts
 */
export async function downloadAttachment(
  conn: SuperhumanConnection,
  messageId: string,
  attachmentId: string,
  _threadId?: string, // Kept for backward compatibility
  _mimeType?: string  // Kept for backward compatibility
): Promise<AttachmentContent> {
  const token = await getCurrentToken(conn);
  return downloadAttachmentDirect(token, messageId, attachmentId);
}

/**
 * Add an attachment to the current draft
 *
 * Note: This still uses CDP because it needs to interact with Superhuman's
 * compose form controller, which manages draft state locally.
 *
 * @param conn - Superhuman connection
 * @param filename - Name of the file
 * @param base64Data - File content as base64 string
 * @param mimeType - MIME type of the file
 */
export async function addAttachment(
  conn: SuperhumanConnection,
  filename: string,
  base64Data: string,
  mimeType: string
): Promise<AddAttachmentResult> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const cfc = window.ViewState?._composeFormController;
          if (!cfc) return { success: false, error: "No compose form controller" };

          const draftKey = Object.keys(cfc).find(k => k.startsWith('draft'));
          if (!draftKey) return { success: false, error: "No draft open" };

          const ctrl = cfc[draftKey];
          if (!ctrl) return { success: false, error: "No draft controller" };

          // Convert base64 to Blob
          const base64 = ${JSON.stringify(base64Data)};
          const mimeType = ${JSON.stringify(mimeType)};
          const filename = ${JSON.stringify(filename)};

          const byteCharacters = atob(base64);
          const byteNumbers = new Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          const blob = new Blob([byteArray], { type: mimeType });

          // Create a File object
          const file = new File([blob], filename, { type: mimeType });

          // Try using _onAddAttachments
          if (typeof ctrl._onAddAttachments === 'function') {
            await ctrl._onAddAttachments([file]);
            return { success: true };
          }

          // Try using onPasteFile
          if (typeof ctrl.onPasteFile === 'function') {
            await ctrl.onPasteFile(file);
            return { success: true };
          }

          // Try accessing draft directly
          const draft = ctrl?.state?.draft;
          if (draft && typeof draft.addUploads === 'function') {
            await draft.addUploads([file]);
            return { success: true };
          }

          return { success: false, error: "No method available to add attachments" };
        } catch (e) {
          return { success: false, error: e.message || "Failed to add attachment" };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  return result.result.value as AddAttachmentResult;
}
