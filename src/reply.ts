/**
 * Reply Module
 *
 * Functions for replying to and forwarding email threads via MCP.
 * Provider-specific OAuth paths have been removed.
 */

import type { ConnectionProvider } from "./connection-provider";
import { requireMcp } from "./mcp-guard";
import { textToHtml } from "./superhuman-api.js";

export interface ReplyResult {
  success: boolean;
  draftId?: string;
  messageId?: string;
  error?: string;
}

/**
 * Reply to a thread (reply to sender only).
 */
export async function replyToThread(
  provider: ConnectionProvider,
  threadId: string,
  body: string,
  send: boolean = false
): Promise<ReplyResult> {
  return replyImpl(provider, threadId, body, send, false);
}

/**
 * Reply-all to a thread (reply to all recipients).
 */
export async function replyAllToThread(
  provider: ConnectionProvider,
  threadId: string,
  body: string,
  send: boolean = false
): Promise<ReplyResult> {
  return replyImpl(provider, threadId, body, send, true);
}

/**
 * Shared implementation for reply and reply-all.
 */
async function replyImpl(
  provider: ConnectionProvider,
  threadId: string,
  body: string,
  send: boolean,
  replyAll: boolean
): Promise<ReplyResult> {
  const mcp = requireMcp(provider);
  const htmlBody = textToHtml(body);
  return mcp.replyToThread(threadId, htmlBody, { replyAll, send });
}

/**
 * Forward a thread
 *
 * Fetches the original message content and constructs a forwarded email
 * with proper "Forwarded message" header.
 *
 * @param provider - Connection provider (must be MCP)
 * @param threadId - The thread ID to forward
 * @param toEmail - The email address to forward to
 * @param body - The message body to include before the forwarded content
 * @param send - If true, send immediately; if false, save as draft
 * @returns Result with success status, optional draft ID, and error message if failed
 */
export async function forwardThread(
  provider: ConnectionProvider,
  threadId: string,
  toEmail: string,
  body: string,
  send: boolean = false
): Promise<ReplyResult> {
  const mcp = requireMcp(provider);

  const htmlBody = body ? textToHtml(body) : "";
  // Read thread to build forward body
  const messages = await mcp.readThread(threadId);
  const lastMessage = messages[messages.length - 1];
  const subject = lastMessage?.subject?.startsWith("Fwd:")
    ? lastMessage.subject
    : `Fwd: ${lastMessage?.subject || "(no subject)"}`;

  const forwardBody = htmlBody
    ? `${htmlBody}<br><br>---------- Forwarded message ---------<br>${lastMessage?.snippet || ""}`
    : `---------- Forwarded message ---------<br>${lastMessage?.snippet || ""}`;

  if (send) {
    return mcp.sendEmail({
      to: [toEmail],
      subject,
      body: forwardBody,
      isHtml: true,
    });
  }
  return mcp.createDraft({
    to: [toEmail],
    subject,
    body: forwardBody,
    isHtml: true,
  });
}

