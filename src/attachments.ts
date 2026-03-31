/**
 * Attachments Module
 *
 * Functions for listing and downloading attachments from Superhuman emails.
 * Provider-specific OAuth APIs have been removed. Attachment listing/downloading
 * now requires MCP provider support (not yet available in MCP server).
 */

import type { ConnectionProvider } from "./connection-provider";

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
 * List all attachments from a thread.
 *
 * Note: Provider-specific OAuth APIs (Gmail/MS Graph) have been removed.
 * This function is no longer operational until MCP server adds attachment support.
 */
export async function listAttachments(
  _provider: ConnectionProvider,
  _threadId: string
): Promise<Attachment[]> {
  throw new Error(
    "listAttachments requires provider API support which has been removed. " +
    "Attachment listing is not yet supported via MCP. " +
    "Use 'superhuman account auth --mcp' and check for MCP server updates."
  );
}

/**
 * Download attachment content as base64.
 *
 * Note: Provider-specific OAuth APIs (Gmail/MS Graph) have been removed.
 * This function is no longer operational until MCP server adds attachment support.
 */
export async function downloadAttachment(
  _provider: ConnectionProvider,
  _messageId: string,
  _attachmentId: string,
  _threadId?: string,
  _mimeType?: string
): Promise<AttachmentContent> {
  throw new Error(
    "downloadAttachment requires provider API support which has been removed. " +
    "Attachment downloading is not yet supported via MCP. " +
    "Use 'superhuman account auth --mcp' and check for MCP server updates."
  );
}

/**
 * Add an attachment to a draft.
 *
 * Note: Provider-specific OAuth APIs (Gmail/MS Graph) have been removed.
 * Attachments for drafts created via the Superhuman native API use
 * uploadAttachmentSuperhuman() in draft-api.ts instead.
 */
export async function addAttachmentDirect(
  _provider: ConnectionProvider,
  _draftId: string,
  _filename: string,
  _base64Data: string,
  _mimeType: string
): Promise<AddAttachmentResult> {
  throw new Error(
    "addAttachmentDirect requires provider API support which has been removed. " +
    "Use the Superhuman native attachment upload path in draft-api.ts instead."
  );
}
