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
import { getCachedToken, loadTokensFromDisk } from "./token-api";

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
  eml: "message/rfc822",
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
  return parts.length > 1 ? parts[parts.length - 1]!.toLowerCase() : "";
}

/**
 * List all attachments from a thread by reading the local SQLite OPFS blob.
 *
 * Primary path: reads attachment metadata from Superhuman's local SQLite cache.
 * Fallback path (Microsoft accounts only): when SQLite returns 0 non-inline
 * attachments, calls MS Graph API `GET /me/messages/{id}/attachments` to fetch
 * the live attachment list. This handles emails that haven't been fully loaded
 * in the Superhuman app yet (Superhuman only populates msg.attachments[] in the
 * local cache after an email is opened).
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
  let resolvedEmail = accountEmail;

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
        resolvedEmail = localEmail;
        break;
      }
    }
  }

  // If SQLite lookup failed entirely (no OPFS blob — e.g. container/server
  // environment without Chrome local storage), attempt MS Graph fallback
  // directly using the threadId as a conversationId.
  if (!thread) {
    await loadTokensFromDisk();
    const token = await getCachedToken(resolvedEmail);
    if (token?.isMicrosoft && token.accessToken) {
      return listAttachmentsMsGraphByConversation(threadId, token.accessToken);
    }
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

  // If SQLite returned no non-inline attachments, the email may not have been
  // opened in the Superhuman app yet (attachment metadata is lazily cached).
  // For Microsoft accounts, fall back to MS Graph API to fetch live attachment
  // metadata. This ensures attachment list works for all emails regardless of
  // whether they've been opened in the app.
  const nonInlineCount = result.filter(a => !a.inline).length;
  if (nonInlineCount === 0) {
    await loadTokensFromDisk();
    const token = await getCachedToken(resolvedEmail);
    if (token?.isMicrosoft && token.accessToken) {
      const graphAttachments = await listAttachmentsMsGraph(
        threadId,
        messages,
        thread.id as string | undefined,
        token.accessToken
      );
      if (graphAttachments.length > 0) {
        return graphAttachments;
      }
    }
  }

  return result;
}

/**
 * List attachments via MS Graph API for a thread whose messages are already
 * known from the local SQLite cache (we have message IDs).
 *
 * Queries each message in the thread for its attachments. Stops after finding
 * at least one message with attachments (typically only the first message with
 * attachments matters for simple threads).
 */
async function listAttachmentsMsGraph(
  threadId: string,
  messages: any[],
  cachedThreadId: string | undefined,
  accessToken: string,
  preResolvedMessageIds?: string[]
): Promise<Attachment[]> {
  const result: Attachment[] = [];

  // Use pre-resolved message IDs if provided (e.g. from conversationId lookup),
  // otherwise collect them from the SQLite-cached message objects.
  const messageIds: string[] = preResolvedMessageIds ?? messages
    .map((m: any) => m.id)
    .filter((id: any): id is string => typeof id === "string" && id.length > 0);

  // If we have no message IDs from SQLite, try using threadId directly as a
  // message ID (for single-message threads where threadId === messageId)
  if (messageIds.length === 0 && threadId) {
    messageIds.push(threadId);
  }

  for (const msgId of messageIds) {
    const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(msgId)}/attachments?$select=id,name,contentType,size,isInline`;
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!resp.ok) continue;

      const data = await resp.json() as { value?: any[] };
      if (!Array.isArray(data.value) || data.value.length === 0) continue;

      for (const att of data.value) {
        // Skip inline images (calendar images, signature images, etc.)
        if (att.isInline) continue;
        result.push({
          id: att.id,
          attachmentId: att.id,
          name: att.name || "attachment",
          mimeType: att.contentType || "application/octet-stream",
          extension: getExtension(att.name || ""),
          messageId: msgId,
          threadId: cachedThreadId || threadId,
          inline: false,
        });
      }

      // Found attachments on this message; no need to query remaining messages
      if (result.length > 0) break;
    } catch {
      // Network error or rate limit — skip this message
    }
  }

  return result;
}

/**
 * List attachments via MS Graph API when no local SQLite data is available
 * (e.g. container/server environment without Chrome's OPFS storage).
 *
 * Uses the threadId as a conversationId to find all messages in the thread,
 * then queries each message with hasAttachments=true for its attachments.
 *
 * MS Graph filter: GET /me/messages?$filter=conversationId eq '{threadId}'
 */
async function listAttachmentsMsGraphByConversation(
  threadId: string,
  accessToken: string
): Promise<Attachment[]> {
  // Step 1: find all message IDs in this conversation that have attachments
  const filterUrl =
    `https://graph.microsoft.com/v1.0/me/messages` +
    `?$filter=conversationId+eq+'${encodeURIComponent(threadId)}'` +
    `&$select=id,hasAttachments`;

  let messageIds: string[] = [];
  try {
    const resp = await fetch(filterUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.ok) {
      const data = await resp.json() as { value?: any[] };
      messageIds = (data.value || [])
        .filter((m: any) => m.hasAttachments)
        .map((m: any) => m.id as string)
        .filter((id: string) => typeof id === "string" && id.length > 0);
    }
  } catch {
    // Network error — fall through with empty list
  }

  if (messageIds.length === 0) {
    return [];
  }

  // Step 2: fetch attachments for each message (same logic as listAttachmentsMsGraph)
  return listAttachmentsMsGraph(threadId, [], threadId, accessToken, messageIds);
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
 * Download the raw RFC 822 (MIME) source of a message — a ready-to-save .eml
 * with the original headers, multipart structure, and nested attachments.
 *
 * Like downloadAttachment, this is a provider-API exception: no Superhuman
 * backend endpoint serves raw message source (Superhuman itself calls the
 * provider internally). Uses the stored OAuth access token from tokens.json.
 *
 *   - Gmail: GET /gmail/v1/users/me/messages/{id}?format=raw (base64url)
 *   - Microsoft: GET /v1.0/me/messages/{id}/$value (raw MIME bytes)
 *
 * @param messageId - Provider message id (from SQLite thread info / listAttachments)
 * @param auth      - OAuth credentials: { accessToken, isMicrosoft }
 */
export async function downloadRawMessage(
  messageId: string,
  auth: AttachmentAuthOptions
): Promise<Uint8Array> {
  if (!auth?.accessToken) {
    throw new Error(
      "downloadRawMessage requires an OAuth access token. " +
      "Pass auth.accessToken from the cached token (token.accessToken)."
    );
  }

  if (auth.isMicrosoft) {
    const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/$value`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`MS Graph API error ${resp.status}: ${text}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=raw`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail API error ${resp.status}: ${text}`);
  }
  const data = await resp.json() as { raw?: string };
  if (!data.raw) {
    throw new Error("Gmail API returned no raw message content");
  }
  const base64 = data.raw.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(base64, "base64"));
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
