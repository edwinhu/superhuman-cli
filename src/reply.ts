/**
 * Reply Module
 *
 * Functions for replying to and forwarding email threads via direct API.
 * Uses token-based API calls (no CDP/browser connection needed).
 */

import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider } from "./mcp-provider";
import { textToHtml } from "./superhuman-api.js";
import {
  sendReplyWithToken,
  sendEmailWithToken,
  createReplyDraftWithToken,
  createDraftWithToken,
  getThreadInfoForReplyWithToken,
} from "./send-api.js";
import { getThreadMessages } from "./token-api";

export interface ReplyResult {
  success: boolean;
  draftId?: string;
  messageId?: string;
  error?: string;
}

/**
 * Reply to a thread (reply to sender only).
 *
 * Uses direct Gmail/Graph API for both sending and draft creation.
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
 *
 * Uses direct Gmail/Graph API for both sending and draft creation.
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
  // Route through MCP if available
  if (provider instanceof McpConnectionProvider) {
    const htmlBody = textToHtml(body);
    return provider.replyToThread(threadId, htmlBody, { replyAll, send });
  }

  const token = await provider.getToken();
  const htmlBody = textToHtml(body);
  const opts = { replyAll, isHtml: true };

  if (send) {
    const result = await sendReplyWithToken(token, threadId, htmlBody, opts);
    if (result.success) {
      return { success: true, messageId: result.messageId };
    }
    return { success: false, error: result.error };
  }

  const result = await createReplyDraftWithToken(token, threadId, htmlBody, opts);
  if (result.success) {
    return { success: true, draftId: result.draftId };
  }
  return { success: false, error: result.error };
}

/**
 * Forward a thread
 *
 * Fetches the original message content and constructs a forwarded email
 * with proper "Forwarded message" header. Uses direct API for both
 * sending and draft creation.
 *
 * @param provider - Connection provider for token resolution
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
  // Route through MCP if available
  if (provider instanceof McpConnectionProvider) {
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

  const token = await provider.getToken();

  // Get thread info for headers (subject, from, to, date)
  const threadInfo = await getThreadInfoForReplyWithToken(token, threadId);
  if (!threadInfo) {
    return { success: false, error: "Could not get thread information for forward" };
  }

  // Get thread messages for the original body content
  const messages = await getThreadMessages(token, threadId);
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const originalBody = lastMessage?.body || "";

  // Build subject with Fwd: prefix
  const subject = threadInfo.subject.startsWith("Fwd:")
    ? threadInfo.subject
    : `Fwd: ${threadInfo.subject}`;

  // Build the forwarded message body
  const userHtml = body ? textToHtml(body) : "";
  const forwardBody = buildForwardBody({
    userHtml,
    from: threadInfo.replyTo || "unknown",
    date: new Date().toUTCString(), // Best effort; threadInfo doesn't have date
    subject: threadInfo.subject,
    to: threadInfo.allTo.join(", ") || "unknown",
    originalBody,
  });

  if (send) {
    const result = await sendEmailWithToken(token, {
      to: [toEmail],
      subject,
      body: forwardBody,
      isHtml: true,
    });

    if (result.success) {
      return { success: true, messageId: result.messageId };
    }
    return { success: false, error: result.error };
  }

  // Draft mode
  const result = await createDraftWithToken(token, {
    to: [toEmail],
    subject,
    body: forwardBody,
    isHtml: true,
  });

  if (result.success) {
    return { success: true, draftId: result.draftId };
  }
  return { success: false, error: result.error };
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
