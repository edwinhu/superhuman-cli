/**
 * Send API Module
 *
 * Email sending via Superhuman backend.
 * Provider-specific OAuth (Gmail/MS Graph) has been removed.
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";
import {
  getUserInfoFromCache,
  createDraftWithUserInfo,
  sendDraftSuperhuman,
  type Recipient,
} from "./draft-api";
import { textToHtml } from "./superhuman-api.js";

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
// ConnectionProvider-based wrappers
//
// These functions accept a ConnectionProvider and route through
// SuperhumanProvider (direct backend) or MCP as fallback.
// ============================================================================

/**
 * Build a UserInfo object from a SuperhumanProvider for use with draft-api functions.
 */
async function userInfoFromProvider(provider: SuperhumanProvider) {
  const token = await provider.getToken();
  const email = await provider.getCurrentEmail();
  // The Superhuman backend bearer is the Superhuman-issued token (or a raw
  // Google/MS *ID* token) — NOT the provider access token. For Microsoft
  // accounts `accessToken` is an MS Graph token, which the backend rejects with
  // 403. Mirror buildUserInfo()'s selection and forward the external-id/device
  // headers so compose `send` and `send --draft` authenticate like `draft send`.
  const authToken = token.superhumanToken?.token || token.idToken || token.accessToken;
  return getUserInfoFromCache(
    token.userId || "",
    email,
    authToken,
    email.split("@")[0],
    token.userExternalId,
    token.deviceId
  );
}

/**
 * Convert string[] emails to Recipient[] for draft-api.
 */
function toRecipients(emails?: string[]): Recipient[] {
  return (emails || []).map((e) => ({ email: e }));
}

/**
 * Send an email using a ConnectionProvider.
 * Routes through SuperhumanProvider (direct backend) or MCP.
 */
export async function sendEmailViaProvider(
  provider: ConnectionProvider,
  options: SendEmailOptions
): Promise<SendResult> {
  if (provider instanceof SuperhumanProvider) {
    const userInfo = await userInfoFromProvider(provider);
    const htmlBody = options.isHtml ? options.body : textToHtml(options.body);
    const draftResult = await createDraftWithUserInfo(userInfo, {
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: htmlBody,
      action: options.threadId ? "reply" : "compose",
      inReplyToThreadId: options.threadId,
      inReplyToRfc822Id: options.inReplyTo,
      references: options.references,
    });
    if (!draftResult.success || !draftResult.draftId || !draftResult.threadId) {
      return { success: false, error: draftResult.error || "Failed to create draft for send" };
    }
    const sendResult = await sendDraftSuperhuman(userInfo, {
      draftId: draftResult.draftId,
      threadId: draftResult.threadId,
      to: toRecipients(options.to),
      cc: toRecipients(options.cc),
      bcc: toRecipients(options.bcc),
      subject: options.subject,
      htmlBody,
      inReplyTo: options.inReplyTo,
      references: options.references,
    });
    if (!sendResult.success) {
      return { success: false, error: sendResult.error };
    }
    return { success: true, messageId: draftResult.draftId, threadId: draftResult.threadId };
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Create a draft using a ConnectionProvider.
 * Routes through SuperhumanProvider (direct backend) or MCP.
 */
export async function createDraftViaProvider(
  provider: ConnectionProvider,
  options: SendEmailOptions
): Promise<DraftResult> {
  if (provider instanceof SuperhumanProvider) {
    const userInfo = await userInfoFromProvider(provider);
    const htmlBody = options.isHtml ? options.body : textToHtml(options.body);
    return createDraftWithUserInfo(userInfo, {
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: htmlBody,
      action: options.threadId ? "reply" : "compose",
      inReplyToThreadId: options.threadId,
      inReplyToRfc822Id: options.inReplyTo,
      references: options.references,
    });
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Update a draft using ConnectionProvider.
 * Routes through SuperhumanProvider (direct backend) or MCP.
 */
export async function updateDraftViaProvider(
  provider: ConnectionProvider,
  draftId: string,
  options: UpdateDraftOptions
): Promise<DraftResult> {
  if (provider instanceof SuperhumanProvider) {
    const userInfo = await userInfoFromProvider(provider);
    const htmlBody = options.body
      ? (options.isHtml ? options.body : textToHtml(options.body))
      : undefined;
    // updateDraftWithUserInfo requires threadId — use draftId as fallback
    const { updateDraftWithUserInfo } = await import("./draft-api");
    const ok = await updateDraftWithUserInfo(userInfo, draftId, draftId, {
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: htmlBody,
    });
    return { success: ok, draftId };
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Send a draft by ID using a ConnectionProvider.
 * Routes through SuperhumanProvider (direct backend) or MCP.
 */
export async function sendDraftByIdViaProvider(
  provider: ConnectionProvider,
  draftId: string
): Promise<SendResult> {
  if (provider instanceof SuperhumanProvider) {
    const userInfo = await userInfoFromProvider(provider);
    // Minimal send — draft already has recipients/subject/body persisted.
    // We need at least the draftId and threadId; use draftId as threadId.
    const sendResult = await sendDraftSuperhuman(userInfo, {
      draftId,
      threadId: draftId,
      to: [],
      subject: "",
      htmlBody: "",
    });
    if (!sendResult.success) {
      return { success: false, error: sendResult.error };
    }
    return { success: true, messageId: draftId };
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Delete a draft using a ConnectionProvider.
 * Routes through SuperhumanProvider (direct backend) or MCP.
 */
export async function deleteDraftViaProvider(
  provider: ConnectionProvider,
  draftId: string
): Promise<{ success: boolean; error?: string }> {
  if (provider instanceof SuperhumanProvider) {
    const { deleteDraftWithUserInfo } = await import("./draft-api");
    const userInfo = await userInfoFromProvider(provider);
    try {
      await deleteDraftWithUserInfo(userInfo, draftId, draftId);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}
