/**
 * Reply Module
 *
 * Functions for replying to and forwarding email threads via MCP.
 * Provider-specific OAuth paths have been removed.
 */

import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider } from "./mcp-provider";
import { textToHtml } from "./superhuman-api.js";
import { readThread } from "./read";

export interface ReplyResult {
  success: boolean;
  draftId?: string;
  messageId?: string;
  error?: string;
}

function requireMcp(provider: ConnectionProvider): asserts provider is McpConnectionProvider {
  if (!(provider instanceof McpConnectionProvider)) {
    throw new Error(
      "MCP provider required. Provider-specific OAuth has been removed. " +
      "Use 'superhuman account auth --mcp' to set up MCP authentication."
    );
  }
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
  requireMcp(provider);
  const htmlBody = textToHtml(body);
  return provider.replyToThread(threadId, htmlBody, { replyAll, send });
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
  requireMcp(provider);

  const htmlBody = body ? textToHtml(body) : "";
  // Read thread to build forward body
  const messages = await provider.readThread(threadId);
  const lastMessage = messages[messages.length - 1];
  const subject = lastMessage?.subject?.startsWith("Fwd:")
    ? lastMessage.subject
    : `Fwd: ${lastMessage?.subject || "(no subject)"}`;

  const forwardBody = htmlBody
    ? `${htmlBody}<br><br>---------- Forwarded message ---------<br>${lastMessage?.snippet || ""}`
    : `---------- Forwarded message ---------<br>${lastMessage?.snippet || ""}`;

  if (send) {
    return provider.sendEmail({
      to: [toEmail],
      subject,
      body: forwardBody,
      isHtml: true,
    });
  }
  return provider.createDraft({
    to: [toEmail],
    subject,
    body: forwardBody,
    isHtml: true,
  });
}

/**
 * Build the forwarded message HTML body.
 */
function buildForwardBody(opts: {
  userHtml: string;
  from: string;
  date: string;
  subject: string;
  to: string;
  originalBody: string;
}): string {
  const parts: string[] = [];

  if (opts.userHtml) {
    parts.push(`<div>${opts.userHtml}</div>`);
    parts.push("<br>");
  }

  parts.push("<div>---------- Forwarded message ---------</div>");
  parts.push(`<div>From: ${escapeHtml(opts.from)}</div>`);
  parts.push(`<div>Date: ${escapeHtml(opts.date)}</div>`);
  parts.push(`<div>Subject: ${escapeHtml(opts.subject)}</div>`);
  parts.push(`<div>To: ${escapeHtml(opts.to)}</div>`);
  parts.push("<br>");

  // If originalBody already contains HTML, use it as-is; otherwise wrap in div
  if (opts.originalBody.includes("<")) {
    parts.push(`<div>${opts.originalBody}</div>`);
  } else {
    parts.push(`<div>${textToHtml(opts.originalBody)}</div>`);
  }

  return parts.join("\n");
}

/**
 * Escape HTML special characters to prevent injection.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
