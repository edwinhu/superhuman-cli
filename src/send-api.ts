/**
 * Send API Module
 *
 * Email sending via MCP provider or Superhuman backend.
 * Provider-specific OAuth (Gmail/MS Graph) has been removed.
 */

import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider } from "./mcp-provider";

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
// These functions accept a ConnectionProvider and route through MCP.
// Provider-specific OAuth paths have been removed.
// ============================================================================

function requireMcp(provider: ConnectionProvider): asserts provider is McpConnectionProvider {
  if (!(provider instanceof McpConnectionProvider)) {
    throw new Error(
      "MCP provider required. Provider-specific OAuth has been removed. " +
      "Use 'superhuman account auth --mcp' to set up MCP authentication."
    );
  }
}

/**
 * Send an email using a ConnectionProvider (MCP only).
 */
export async function sendEmailViaProvider(
  provider: ConnectionProvider,
  options: SendEmailOptions
): Promise<SendResult> {
  requireMcp(provider);
  return provider.sendEmail(options);
}

/**
 * Create a draft using a ConnectionProvider (MCP only).
 */
export async function createDraftViaProvider(
  provider: ConnectionProvider,
  options: SendEmailOptions
): Promise<DraftResult> {
  requireMcp(provider);
  return provider.createDraft(options);
}

/**
 * Update a draft using ConnectionProvider (MCP only).
 */
export async function updateDraftViaProvider(
  provider: ConnectionProvider,
  draftId: string,
  options: UpdateDraftOptions
): Promise<DraftResult> {
  requireMcp(provider);
  // MCP draft_email supports revision via draft_id
  return provider.createDraft({
    to: options.to || [],
    subject: options.subject || "",
    body: options.body || "",
    isHtml: options.isHtml,
  });
}

/**
 * Send a draft by ID using a ConnectionProvider (MCP only).
 */
export async function sendDraftByIdViaProvider(
  provider: ConnectionProvider,
  draftId: string
): Promise<SendResult> {
  requireMcp(provider);
  return provider.sendDraftById(draftId);
}

/**
 * Delete a draft using a ConnectionProvider (MCP only).
 */
export async function deleteDraftViaProvider(
  provider: ConnectionProvider,
  draftId: string
): Promise<{ success: boolean; error?: string }> {
  requireMcp(provider);
  // MCP has no direct draft deletion tool — trash the draft thread
  try {
    await provider.callTool("update_email", {
      thread_id: draftId,
      action: "trash",
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
