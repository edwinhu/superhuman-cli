/**
 * Attachments Module
 *
 * Functions for listing and downloading attachments from Superhuman emails.
 *
 * List: reads attachment metadata from the local SQLite OPFS blob (no API call needed).
 * Download: calls the provider's attachment API directly using the stored OAuth access token:
 *   - Gmail accounts: GET /gmail/v1/users/me/messages/{messageId}/attachments/{attachmentId}
 *   - Microsoft accounts: GET /graph.microsoft.com/v1.0/me/messages/{messageId}/attachments/{attachmentId}
 */

import type { ConnectionProvider } from "./connection-provider";
import { readThreadFromDB, listLocalAccounts } from "./sqlite-search";

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

export interface AttachmentAuthOptions {
  /** OAuth access token (from tokens.json: account.accessToken) */
  accessToken: string;
  /** True for Microsoft/Outlook accounts, false for Gmail */
  isMicrosoft: boolean;
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
 * List all attachments from a thread by reading the local SQLite OPFS blob.
 *
 * No API call is needed — attachment metadata (attachmentId, name, type, size)
 * is stored in the thread JSON in Superhuman's local database.
 *
 * @param _provider - Not used (kept for interface compatibility)
 * @param threadId  - Thread ID or message ID to look up
 * @param accountEmail - Account email for OPFS blob lookup (required for SQLite path)
 */
export async function listAttachments(
  _provider: ConnectionProvider,
  threadId: string,
  accountEmail?: string
): Promise<Attachment[]> {
  // If no account email provided, fall back to empty list (can't query SQLite)
  if (!accountEmail) {
    return [];
  }

  let thread = readThreadFromDB(accountEmail, threadId);

  // If the primary account lookup failed, the active CDP tab may have resolved
  // to a different account than the one that owns this thread (e.g. Gmail tab
  // active while looking up an Outlook thread ID). Fall back to all local
  // accounts that have an OPFS blob.
  if (!thread) {
    for (const localEmail of listLocalAccounts()) {
      if (localEmail.toLowerCase() === accountEmail.toLowerCase()) continue;
      const candidate = readThreadFromDB(localEmail, threadId);
      if (candidate) {
        thread = candidate;
        break;
      }
    }
  }

  if (!thread) {
    return [];
  }

  const messages: any[] = Array.isArray(thread.messages)
    ? (thread.messages as any[])
    : [];

  const result: Attachment[] = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.attachments)) continue;
    for (const att of msg.attachments) {
      if (!att.attachmentId) continue;
      result.push({
        id: att.attachmentId,
        attachmentId: att.attachmentId,
        name: att.name || "attachment",
        mimeType: att.type || "application/octet-stream",
        extension: getExtension(att.name || ""),
        messageId: att.messageId || msg.id || "",
        threadId: att.threadId || (thread.id as string) || threadId,
        inline: att.inline ?? false,
      });
    }
  }

  return result;
}

/**
 * Download attachment content as base64.
 *
 * Routes to Gmail API or MS Graph API depending on account type, using the
 * stored OAuth access token from tokens.json.
 *
 * @param _provider  - Not used (kept for interface compatibility)
 * @param messageId  - The message ID containing the attachment
 * @param attachmentId - The provider attachment ID (from listAttachments)
 * @param _threadId  - Optional thread ID (unused, kept for call-site compatibility)
 * @param _mimeType  - Optional MIME type hint (unused, kept for call-site compatibility)
 * @param auth       - OAuth credentials: { accessToken, isMicrosoft }
 */
export async function downloadAttachment(
  _provider: ConnectionProvider,
  messageId: string,
  attachmentId: string,
  _threadId?: string,
  _mimeType?: string,
  auth?: AttachmentAuthOptions
): Promise<AttachmentContent> {
  if (!auth?.accessToken) {
    throw new Error(
      "downloadAttachment requires an OAuth access token. " +
      "Pass auth.accessToken from the cached token (token.accessToken)."
    );
  }

  if (auth.isMicrosoft) {
    return downloadAttachmentMsGraph(messageId, attachmentId, auth.accessToken);
  } else {
    return downloadAttachmentGmail(messageId, attachmentId, auth.accessToken);
  }
}

/**
 * Download an attachment via the Gmail REST API.
 * Endpoint: GET /gmail/v1/users/me/messages/{messageId}/attachments/{attachmentId}
 */
async function downloadAttachmentGmail(
  messageId: string,
  attachmentId: string,
  accessToken: string
): Promise<AttachmentContent> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail API error ${resp.status}: ${text}`);
  }

  const data = await resp.json() as { data: string; size: number };
  // Gmail API returns base64url-encoded data; convert to standard base64
  const base64 = (data.data || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  return {
    data: base64,
    size: data.size || Math.ceil((base64.length * 3) / 4),
  };
}

/**
 * Download an attachment via the MS Graph REST API.
 * Endpoint: GET /v1.0/me/messages/{messageId}/attachments/{attachmentId}
 */
async function downloadAttachmentMsGraph(
  messageId: string,
  attachmentId: string,
  accessToken: string
): Promise<AttachmentContent> {
  const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`MS Graph API error ${resp.status}: ${text}`);
  }

  const data = await resp.json() as {
    contentBytes?: string;
    size?: number;
    name?: string;
  };

  const base64 = data.contentBytes || "";
  return {
    data: base64,
    size: data.size || Math.ceil((base64.length * 3) / 4),
  };
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
