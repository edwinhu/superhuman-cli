/**
 * Attachments Module
 *
 * Functions for listing and downloading attachments from Superhuman emails
 * via direct Gmail/MS Graph API.
 */

import type { ConnectionProvider } from "./connection-provider";
import {
  getThreadDirect,
  downloadAttachmentDirect,
  addAttachmentToDraft,
} from "./token-api";

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

export interface FileAttachmentData {
  filename: string;
  base64Data: string;
  mimeType: string;
}

const MIME_TYPES: Record<string, string> = {
  csv: "text/csv",
  txt: "text/plain",
  html: "text/html",
  pdf: "application/pdf",
  json: "application/json",
  xml: "application/xml",
  zip: "application/zip",
  gz: "application/gzip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

/**
 * Read a file from disk and return its content as base64 with metadata.
 */
export async function readFileAsBase64(filePath: string): Promise<FileAttachmentData> {
  let resolved = filePath;
  if (resolved.startsWith("~/")) {
    resolved = resolved.replace("~", process.env.HOME || "");
  }

  const { resolve, basename } = await import("path");
  resolved = resolve(resolved);

  const file = Bun.file(resolved);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${filePath}`);
  }

  const bytes = await file.bytes();
  const base64Data = Buffer.from(bytes).toString("base64");

  const filename = basename(resolved);
  const ext = getExtension(filename);
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";

  return { filename, base64Data, mimeType };
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
  provider: ConnectionProvider,
  threadId: string
): Promise<Attachment[]> {
  const token = await provider.getToken();
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
  provider: ConnectionProvider,
  messageId: string,
  attachmentId: string,
  _threadId?: string, // Kept for backward compatibility
  _mimeType?: string  // Kept for backward compatibility
): Promise<AttachmentContent> {
  const token = await provider.getToken();
  return downloadAttachmentDirect(token, messageId, attachmentId);
}

/**
 * Add an attachment to a draft via direct API
 *
 * This function adds attachments to drafts created via the direct API
 * (createDraftGmail/createDraftMsgraph). The draft must exist in the
 * native email provider's Drafts folder.
 *
 * @param provider - The connection provider (for token extraction)
 * @param draftId - The draft ID (Gmail draft ID or MS Graph message ID)
 * @param filename - Name of the file
 * @param base64Data - File content as base64 string
 * @param mimeType - MIME type of the file
 */
export async function addAttachmentDirect(
  provider: ConnectionProvider,
  draftId: string,
  filename: string,
  base64Data: string,
  mimeType: string
): Promise<AddAttachmentResult> {
  try {
    const token = await provider.getToken();
    const success = await addAttachmentToDraft(token, draftId, filename, mimeType, base64Data);
    return { success };
  } catch (e: any) {
    return { success: false, error: e.message || "Failed to add attachment" };
  }
}
