/**
 * Reply Module
 *
 * Functions for replying to email threads via Superhuman's internal APIs.
 */

import type { SuperhumanConnection } from "./superhuman-api";
import {
  openCompose,
  addRecipient,
  addCcRecipient,
  setSubject,
  setBody,
  saveDraft,
  sendDraft,
  textToHtml,
} from "./superhuman-api";
import { readThread, type ThreadMessage } from "./read";
import { getCurrentAccount } from "./accounts";

export interface ReplyResult {
  success: boolean;
  draftId?: string;
}

/**
 * Format the attribution line for quoted reply
 */
function formatAttribution(message: ThreadMessage): string {
  const senderName = message.from.name || message.from.email;
  const date = message.date || "Unknown date";
  return `On ${date}, ${senderName} wrote:`;
}

/**
 * Create HTML blockquote for the original message
 */
function createQuotedMessage(message: ThreadMessage): string {
  const attribution = formatAttribution(message);
  const originalContent = message.snippet || "";

  return `<blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex;">
  <p>${attribution}</p>
  <p>${originalContent}</p>
</blockquote>`;
}

/**
 * Strip existing "Re:" prefix from subject to avoid "Re: Re:"
 */
function stripRePrefix(subject: string): string {
  // Match "Re:" at the start, case-insensitive, with optional whitespace
  return subject.replace(/^Re:\s*/i, "");
}

/**
 * Strip existing "Fwd:" prefix from subject to avoid "Fwd: Fwd:"
 */
function stripFwdPrefix(subject: string): string {
  // Match "Fwd:" at the start, case-insensitive, with optional whitespace
  return subject.replace(/^Fwd:\s*/i, "");
}

/**
 * Format forward subject with single "Fwd:" prefix
 */
function formatForwardSubject(originalSubject: string): string {
  const stripped = stripFwdPrefix(originalSubject);
  return `Fwd: ${stripped}`;
}

/**
 * Format recipient list as a display string
 */
function formatRecipientList(
  recipients: Array<{ email: string; name: string }>
): string {
  return recipients
    .map((r) => (r.name ? `${r.name} <${r.email}>` : r.email))
    .join(", ");
}

/**
 * Create the forward header with message metadata
 */
function createForwardHeader(message: ThreadMessage): string {
  const senderDisplay = message.from.name
    ? `${message.from.name} <${message.from.email}>`
    : message.from.email;
  const recipientDisplay = formatRecipientList(message.to);

  return `---------- Forwarded message ---------
From: ${senderDisplay}
Date: ${message.date}
Subject: ${message.subject}
To: ${recipientDisplay}`;
}

/**
 * Format reply subject with single "Re:" prefix
 */
function formatReplySubject(originalSubject: string): string {
  const stripped = stripRePrefix(originalSubject);
  return `Re: ${stripped}`;
}

/**
 * Reply to a thread
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to reply to
 * @param body - The reply body text
 * @param send - If true, send immediately; if false, save as draft
 * @returns Result with success status and optional draft ID
 */
export async function replyToThread(
  conn: SuperhumanConnection,
  threadId: string,
  body: string,
  send: boolean = false
): Promise<ReplyResult> {
  // Get thread messages
  const messages = await readThread(conn, threadId);
  if (messages.length === 0) {
    return { success: false };
  }

  // Get the last message to reply to
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    return { success: false };
  }

  // Open compose form
  const draftKey = await openCompose(conn);
  if (!draftKey) {
    return { success: false };
  }

  // Set recipient to original sender
  const recipientAdded = await addRecipient(
    conn,
    lastMessage.from.email,
    lastMessage.from.name
  );
  if (!recipientAdded) {
    return { success: false };
  }

  // Set subject with "Re:" prefix (avoiding duplicate)
  const replySubject = formatReplySubject(lastMessage.subject);
  const subjectSet = await setSubject(conn, replySubject);
  if (!subjectSet) {
    return { success: false };
  }

  // Create the reply body with quoted original message
  const quotedMessage = createQuotedMessage(lastMessage);
  const bodyHtml = textToHtml(body);
  const fullBody = `${bodyHtml}\n${quotedMessage}`;

  const bodySet = await setBody(conn, fullBody);
  if (!bodySet) {
    return { success: false };
  }

  // Save or send the draft
  if (send) {
    const sent = await sendDraft(conn);
    return { success: sent };
  } else {
    const saved = await saveDraft(conn);
    return { success: saved, draftId: draftKey };
  }
}

/**
 * Reply-all to a thread
 *
 * Same as replyToThread, but also adds all original To/Cc recipients
 * to the Cc field (excluding self).
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to reply to
 * @param body - The reply body text
 * @param send - If true, send immediately; if false, save as draft
 * @returns Result with success status and optional draft ID
 */
export async function replyAllToThread(
  conn: SuperhumanConnection,
  threadId: string,
  body: string,
  send: boolean = false
): Promise<ReplyResult> {
  // Get current account to exclude self from Cc
  const currentEmail = await getCurrentAccount(conn);

  // Get thread messages
  const messages = await readThread(conn, threadId);
  if (messages.length === 0) {
    return { success: false };
  }

  // Get the last message to reply to
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    return { success: false };
  }

  // Open compose form
  const draftKey = await openCompose(conn);
  if (!draftKey) {
    return { success: false };
  }

  // Set recipient to original sender
  const recipientAdded = await addRecipient(
    conn,
    lastMessage.from.email,
    lastMessage.from.name
  );
  if (!recipientAdded) {
    return { success: false };
  }

  // Add all original To/Cc recipients to Cc (excluding self and original sender)
  const allOriginalRecipients = [
    ...lastMessage.to.map((r) => ({ email: r.email, name: r.name })),
    ...lastMessage.cc.map((r) => ({ email: r.email, name: r.name })),
  ];

  // Filter out self and original sender
  const ccRecipients = allOriginalRecipients.filter(
    (r) =>
      r.email.length > 0 &&
      r.email !== currentEmail &&
      r.email !== lastMessage.from.email
  );

  // Add each Cc recipient
  for (const recipient of ccRecipients) {
    await addCcRecipient(conn, recipient.email, recipient.name);
  }

  // Set subject with "Re:" prefix (avoiding duplicate)
  const replySubject = formatReplySubject(lastMessage.subject);
  const subjectSet = await setSubject(conn, replySubject);
  if (!subjectSet) {
    return { success: false };
  }

  // Create the reply body with quoted original message
  const quotedMessage = createQuotedMessage(lastMessage);
  const bodyHtml = textToHtml(body);
  const fullBody = `${bodyHtml}\n${quotedMessage}`;

  const bodySet = await setBody(conn, fullBody);
  if (!bodySet) {
    return { success: false };
  }

  // Save or send the draft
  if (send) {
    const sent = await sendDraft(conn);
    return { success: sent };
  } else {
    const saved = await saveDraft(conn);
    return { success: saved, draftId: draftKey };
  }
}

/**
 * Forward a thread
 *
 * Creates a new email with the forwarded message content and metadata.
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to forward
 * @param toEmail - The email address to forward to
 * @param body - The message body to include before the forwarded content
 * @param send - If true, send immediately; if false, save as draft
 * @returns Result with success status and optional draft ID
 */
export async function forwardThread(
  conn: SuperhumanConnection,
  threadId: string,
  toEmail: string,
  body: string,
  send: boolean = false
): Promise<ReplyResult> {
  // Get thread messages
  const messages = await readThread(conn, threadId);
  if (messages.length === 0) {
    return { success: false };
  }

  // Get the last message to forward
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    return { success: false };
  }

  // Open compose form
  const draftKey = await openCompose(conn);
  if (!draftKey) {
    return { success: false };
  }

  // Set recipient to the forward target
  const recipientAdded = await addRecipient(conn, toEmail);
  if (!recipientAdded) {
    return { success: false };
  }

  // Set subject with "Fwd:" prefix (avoiding duplicate)
  const forwardSubject = formatForwardSubject(lastMessage.subject);
  const subjectSet = await setSubject(conn, forwardSubject);
  if (!subjectSet) {
    return { success: false };
  }

  // Create the forward body with header and original message
  const forwardHeader = createForwardHeader(lastMessage);
  const originalContent = lastMessage.snippet || "";
  const bodyHtml = textToHtml(body);
  const headerHtml = textToHtml(forwardHeader);
  const originalHtml = textToHtml(originalContent);
  const fullBody = `${bodyHtml}\n\n${headerHtml}\n\n${originalHtml}`;

  const bodySet = await setBody(conn, fullBody);
  if (!bodySet) {
    return { success: false };
  }

  // Save or send the draft
  if (send) {
    const sent = await sendDraft(conn);
    return { success: sent };
  } else {
    const saved = await saveDraft(conn);
    return { success: saved, draftId: draftKey };
  }
}
