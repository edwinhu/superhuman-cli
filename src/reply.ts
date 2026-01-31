/**
 * Reply Module
 *
 * Functions for replying to email threads via Superhuman's internal APIs.
 * Uses native Superhuman commands for proper email threading.
 */

import type { SuperhumanConnection } from "./superhuman-api";
import {
  openReplyCompose,
  openReplyAllCompose,
  openForwardCompose,
  addRecipient,
  setBody,
  saveDraft,
  sendDraft,
  textToHtml,
} from "./superhuman-api";

export interface ReplyResult {
  success: boolean;
  draftId?: string;
}

/**
 * Reply to a thread
 *
 * Uses Superhuman's native REPLY_POP_OUT command which properly sets up
 * threading (threadId, inReplyTo, references), recipients, and subject.
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to reply to (must be the currently open thread)
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
  // Use native reply command which handles threading correctly
  const draftKey = await openReplyCompose(conn);
  if (!draftKey) {
    return { success: false };
  }

  // Set the reply body (Superhuman already has recipients and subject set)
  const bodyHtml = textToHtml(body);
  const bodySet = await setBody(conn, bodyHtml);
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
 * Uses Superhuman's native REPLY_ALL_POP_OUT command which properly sets up
 * threading (threadId, inReplyTo, references), all recipients (To and Cc),
 * and subject automatically.
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to reply to (must be the currently open thread)
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
  // Use native reply-all command which handles threading and recipients correctly
  const draftKey = await openReplyAllCompose(conn);
  if (!draftKey) {
    return { success: false };
  }

  // Set the reply body (Superhuman already has recipients and subject set)
  const bodyHtml = textToHtml(body);
  const bodySet = await setBody(conn, bodyHtml);
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
 * Uses Superhuman's native FORWARD_POP_OUT command which properly sets up
 * the forwarded message content, subject, and formatting.
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to forward (must be the currently open thread)
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
  // Use native forward command which handles subject and forwarded content
  const draftKey = await openForwardCompose(conn);
  if (!draftKey) {
    return { success: false };
  }

  // Set recipient to the forward target
  const recipientAdded = await addRecipient(conn, toEmail);
  if (!recipientAdded) {
    return { success: false };
  }

  // Set the message body before the forwarded content
  if (body) {
    const bodyHtml = textToHtml(body);
    const bodySet = await setBody(conn, bodyHtml);
    if (!bodySet) {
      return { success: false };
    }
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
