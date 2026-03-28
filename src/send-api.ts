/**
 * Send API Module
 *
 * Direct email sending via Gmail API and Microsoft Graph API.
 * Uses token-based API calls through token-api.ts (no CDP needed).
 *
 * Gmail: Uses POST /gmail/v1/users/me/messages/send
 * Microsoft Graph: Uses POST /me/sendMail
 */

import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider } from "./mcp-provider";
import type { TokenInfo } from "./token-api";
import {
  sendEmailDirect,
  createDraftDirect,
  sendReplyDirect,
  createReplyDraftDirect,
  deleteDraftDirect,
  sendDraftDirect,
  getThreadInfoDirect,
  updateDraftDirect,
} from "./token-api";

/**
 * Options for sending an email
 */
export interface SendEmailOptions {
  /** Recipient email addresses */
  to: string[];
  /** CC recipients (optional) */
  cc?: string[];
  /** BCC recipients (optional) */
  bcc?: string[];
  /** Email subject */
  subject: string;
  /** Email body (plain text or HTML) */
  body: string;
  /** Whether the body is HTML (default: false, will be converted to HTML) */
  isHtml?: boolean;
  /** Thread ID for replies (optional) */
  threadId?: string;
  /** Message-ID header of the message being replied to (for threading) */
  inReplyTo?: string;
  /** References header values (for threading) */
  references?: string[];
}

/**
 * Result of a send operation
 */
export interface SendResult {
  success: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
}

/**
 * Result of a draft operation
 */
export interface DraftResult {
  success: boolean;
  draftId?: string;
  messageId?: string;
  error?: string;
}

/**
 * Options for updating a draft
 */
export interface UpdateDraftOptions {
  /** Recipient email addresses (optional - keep existing if not provided) */
  to?: string[];
  /** CC recipients (optional) */
  cc?: string[];
  /** BCC recipients (optional) */
  bcc?: string[];
  /** Email subject (optional) */
  subject?: string;
  /** Email body (plain text or HTML) */
  body?: string;
  /** Whether the body is HTML (default: true) */
  isHtml?: boolean;
}

/**
 * Thread information needed for constructing a reply
 */
export interface ThreadInfoForReply {
  threadId: string;
  subject: string;
  lastMessageId: string | null;
  references: string[];
  replyTo: string | null;
  /** All To recipients from the last message (for reply-all) */
  allTo: string[];
  /** All Cc recipients from the last message (for reply-all) */
  allCc: string[];
  /** Current user's email (to exclude from recipients) */
  myEmail: string | null;
}

// ============================================================================
// Token-based Functions (direct API, no CDP needed)
//
// Use these when you have a TokenInfo object (e.g., from --account flag).
// ============================================================================

/**
 * Send email using direct API (no CDP).
 *
 * @param token - Token info from token-api.ts
 * @param options - Email options
 * @returns Result with success status and message ID
 */
export async function sendEmailWithToken(
  token: TokenInfo,
  options: SendEmailOptions
): Promise<SendResult> {
  const result = await sendEmailDirect(token, {
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    subject: options.subject,
    body: options.body,
    isHtml: options.isHtml ?? true,
    threadId: options.threadId,
    inReplyTo: options.inReplyTo,
    references: options.references,
  });

  if (!result) {
    return { success: false, error: "Failed to send email via direct API" };
  }

  return {
    success: true,
    messageId: result.messageId,
    threadId: result.threadId,
  };
}

/**
 * Create a draft using direct API (no CDP).
 *
 * @param token - Token info from token-api.ts
 * @param options - Email options
 * @returns Result with success status and draft ID
 */
export async function createDraftWithToken(
  token: TokenInfo,
  options: SendEmailOptions
): Promise<DraftResult> {
  const result = await createDraftDirect(token, {
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    subject: options.subject,
    body: options.body,
    isHtml: options.isHtml ?? true,
    threadId: options.threadId,
    inReplyTo: options.inReplyTo,
    references: options.references,
  });

  if (!result) {
    return { success: false, error: "Failed to create draft via direct API" };
  }

  return {
    success: true,
    draftId: result.draftId,
    messageId: result.messageId,
  };
}

/**
 * Send a reply using direct API (no CDP).
 *
 * @param token - Token info from token-api.ts
 * @param threadId - Thread ID to reply to
 * @param body - Reply body
 * @param options - Additional options
 * @returns Result with success status and message ID
 */
export async function sendReplyWithToken(
  token: TokenInfo,
  threadId: string,
  body: string,
  options?: {
    replyAll?: boolean;
    cc?: string[];
    bcc?: string[];
    isHtml?: boolean;
  }
): Promise<SendResult> {
  const result = await sendReplyDirect(token, threadId, body, options);

  if (!result) {
    return { success: false, error: "Failed to send reply via direct API" };
  }

  return {
    success: true,
    messageId: result.messageId,
    threadId: result.threadId,
  };
}

/**
 * Create a reply draft using direct API (no CDP).
 *
 * @param token - Token info from token-api.ts
 * @param threadId - Thread ID to reply to
 * @param body - Reply body
 * @param options - Additional options
 * @returns Result with success status and draft ID
 */
export async function createReplyDraftWithToken(
  token: TokenInfo,
  threadId: string,
  body: string,
  options?: {
    replyAll?: boolean;
    cc?: string[];
    bcc?: string[];
    isHtml?: boolean;
  }
): Promise<DraftResult> {
  const result = await createReplyDraftDirect(token, threadId, body, options);

  if (!result) {
    return { success: false, error: "Failed to create reply draft via direct API" };
  }

  return {
    success: true,
    draftId: result.draftId,
    messageId: result.messageId,
  };
}

/**
 * Update a draft using direct API (no CDP).
 *
 * @param token - Token info from token-api.ts
 * @param draftId - Draft ID to update
 * @param options - Fields to update
 * @returns Result with draftId on success
 */
export async function updateDraftWithToken(
  token: TokenInfo,
  draftId: string,
  options: UpdateDraftOptions
): Promise<DraftResult> {
  const result = await updateDraftDirect(token, draftId, {
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    subject: options.subject,
    body: options.body,
    isHtml: options.isHtml,
  });

  if (!result) {
    return { success: false, error: "Failed to update draft via direct API" };
  }

  return {
    success: true,
    draftId: result.draftId,
    messageId: result.messageId,
  };
}

/**
 * Delete a draft using direct API (no CDP).
 *
 * @param token - Token info from token-api.ts
 * @param draftId - Draft ID to delete
 * @returns Result with success status
 */
export async function deleteDraftWithToken(
  token: TokenInfo,
  draftId: string
): Promise<{ success: boolean; error?: string }> {
  const success = await deleteDraftDirect(token, draftId);

  if (!success) {
    return { success: false, error: "Failed to delete draft via direct API" };
  }

  return { success: true };
}

/**
 * Send a draft by ID using direct API (no CDP).
 *
 * @param token - Token info from token-api.ts
 * @param draftId - Draft ID to send
 * @returns Result with success status and message ID
 */
export async function sendDraftByIdWithToken(
  token: TokenInfo,
  draftId: string
): Promise<SendResult> {
  const result = await sendDraftDirect(token, draftId);

  if (!result) {
    return { success: false, error: "Failed to send draft via direct API" };
  }

  return {
    success: true,
    messageId: result.messageId,
    threadId: result.threadId,
  };
}

/**
 * Get thread info for reply using direct API (no CDP).
 *
 * @param token - Token info from token-api.ts
 * @param threadId - Thread ID to get info for
 * @returns Thread info or null
 */
export async function getThreadInfoForReplyWithToken(
  token: TokenInfo,
  threadId: string
): Promise<ThreadInfoForReply | null> {
  const info = await getThreadInfoDirect(token, threadId);

  if (!info) {
    return null;
  }

  return {
    threadId,
    subject: info.subject,
    lastMessageId: info.messageId,
    references: info.references,
    replyTo: info.from,
    allTo: info.to,
    allCc: info.cc,
    myEmail: token.email,
  };
}

// ============================================================================
// ConnectionProvider-based wrappers
//
// These functions accept a ConnectionProvider instead of a SuperhumanConnection,
// resolving tokens internally and delegating to the *WithToken implementations.
// ============================================================================

/**
 * Send an email using a ConnectionProvider (no CDP needed).
 */
export async function sendEmailViaProvider(
  provider: ConnectionProvider,
  options: SendEmailOptions
): Promise<SendResult> {
  if (provider instanceof McpConnectionProvider) {
    return provider.sendEmail(options);
  }
  const token = await provider.getToken();
  return sendEmailWithToken(token, options);
}

/**
 * Create a draft using a ConnectionProvider (no CDP needed).
 */
export async function createDraftViaProvider(
  provider: ConnectionProvider,
  options: SendEmailOptions
): Promise<DraftResult> {
  if (provider instanceof McpConnectionProvider) {
    return provider.createDraft(options);
  }
  const token = await provider.getToken();
  return createDraftWithToken(token, options);
}

/**
 * Update a draft using ConnectionProvider (no CDP).
 */
export async function updateDraftViaProvider(
  provider: ConnectionProvider,
  draftId: string,
  options: UpdateDraftOptions
): Promise<DraftResult> {
  const token = await provider.getToken();
  return updateDraftWithToken(token, draftId, options);
}

/**
 * Send a draft by ID using a ConnectionProvider (no CDP needed).
 */
export async function sendDraftByIdViaProvider(
  provider: ConnectionProvider,
  draftId: string
): Promise<SendResult> {
  const token = await provider.getToken();
  return sendDraftByIdWithToken(token, draftId);
}

/**
 * Delete a draft using a ConnectionProvider (no CDP needed).
 */
export async function deleteDraftViaProvider(
  provider: ConnectionProvider,
  draftId: string
): Promise<{ success: boolean; error?: string }> {
  const token = await provider.getToken();
  return deleteDraftWithToken(token, draftId);
}
