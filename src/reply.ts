/**
 * Reply Module
 *
 * Functions for replying to email threads via Superhuman's internal APIs.
 * Uses native Superhuman commands for drafts, and direct API for sending.
 */

import type { SuperhumanConnection } from "./superhuman-api.js";
import {
  openReplyCompose,
  openReplyAllCompose,
  openForwardCompose,
  addRecipient,
  setBody,
  saveDraft,
  textToHtml,
} from "./superhuman-api.js";
import { sendReply, sendEmail, getThreadInfoForReply } from "./send-api.js";

export interface ReplyResult {
  success: boolean;
  draftId?: string;
  messageId?: string;
  error?: string;
}

/**
 * Complete a draft by saving it (used only for draft mode, not send)
 */
async function saveDraftAndClose(
  conn: SuperhumanConnection,
  draftKey: string
): Promise<ReplyResult> {
  const saved = await saveDraft(conn, draftKey);
  if (!saved) {
    return { success: false, error: "Failed to save draft" };
  }
  return { success: true, draftId: draftKey };
}

/**
 * Retry a function with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T | null>,
  maxRetries: number = 3,
  baseDelay: number = 500
): Promise<T | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    if (attempt < maxRetries - 1) {
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return null;
}

/**
 * Reply to a thread
 *
 * When sending: Uses direct Gmail/Graph API for reliable delivery.
 * When drafting: Uses Superhuman's native REPLY_POP_OUT command.
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to reply to
 * @param body - The reply body text
 * @param send - If true, send immediately via API; if false, save as draft
 * @returns Result with success status, optional draft/message ID, and error message if failed
 */
export async function replyToThread(
  conn: SuperhumanConnection,
  threadId: string,
  body: string,
  send: boolean = false
): Promise<ReplyResult> {
  // For sending, use the direct API approach (faster and more reliable)
  if (send) {
    const result = await sendReply(conn, threadId, textToHtml(body), {
      replyAll: false,
      isHtml: true,
    });

    if (result.success) {
      return { success: true, messageId: result.messageId };
    }
    return { success: false, error: result.error };
  }

  // For drafts, use the UI approach (creates proper draft in Superhuman)
  const draftKey = await withRetry(() => openReplyCompose(conn, threadId), 3, 500);
  if (!draftKey) {
    return {
      success: false,
      error: "Failed to open reply compose (UI may be blocked by existing compose window or overlay)"
    };
  }

  const bodySet = await setBody(conn, textToHtml(body), draftKey);
  if (!bodySet) {
    return { success: false, error: "Failed to set reply body" };
  }

  return saveDraftAndClose(conn, draftKey);
}

/**
 * Reply-all to a thread
 *
 * When sending: Uses direct Gmail/Graph API for reliable delivery.
 * When drafting: Uses Superhuman's native REPLY_ALL_POP_OUT command.
 *
 * Note: For reply-all sends, we use the UI approach to properly capture
 * all recipients (To and Cc) which requires thread analysis that the
 * simple API doesn't provide. The API is used for the final send.
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to reply to
 * @param body - The reply body text
 * @param send - If true, send immediately; if false, save as draft
 * @returns Result with success status, optional draft ID, and error message if failed
 */
export async function replyAllToThread(
  conn: SuperhumanConnection,
  threadId: string,
  body: string,
  send: boolean = false
): Promise<ReplyResult> {
  // For sending reply-all, we need to get all recipients from the thread
  // The sendReply function handles this with replyAll: true
  if (send) {
    const result = await sendReply(conn, threadId, textToHtml(body), {
      replyAll: true,
      isHtml: true,
    });

    if (result.success) {
      return { success: true, messageId: result.messageId };
    }
    return { success: false, error: result.error };
  }

  // For drafts, use the UI approach (creates proper draft with all recipients)
  const draftKey = await withRetry(() => openReplyAllCompose(conn, threadId), 3, 500);
  if (!draftKey) {
    return {
      success: false,
      error: "Failed to open reply-all compose (UI may be blocked by existing compose window or overlay)"
    };
  }

  const bodySet = await setBody(conn, textToHtml(body), draftKey);
  if (!bodySet) {
    return { success: false, error: "Failed to set reply body" };
  }

  return saveDraftAndClose(conn, draftKey);
}

/**
 * Forward a thread
 *
 * When sending: Uses direct Gmail/Graph API for reliable delivery.
 * When drafting: Uses Superhuman's native FORWARD_POP_OUT command.
 *
 * Note: Forward requires getting the original message content to include
 * in the forwarded email. For now, we use the UI approach for both
 * drafts and sends to properly capture the forwarded content.
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to forward
 * @param toEmail - The email address to forward to
 * @param body - The message body to include before the forwarded content
 * @param send - If true, send immediately; if false, save as draft
 * @returns Result with success status, optional draft ID, and error message if failed
 */
export async function forwardThread(
  conn: SuperhumanConnection,
  threadId: string,
  toEmail: string,
  body: string,
  send: boolean = false
): Promise<ReplyResult> {
  // For forward, we need the original message content which is complex to get via API
  // Use UI approach to set up the forward, then use API to send if requested
  const draftKey = await withRetry(() => openForwardCompose(conn, threadId), 3, 500);
  if (!draftKey) {
    return {
      success: false,
      error: "Failed to open forward compose (UI may be blocked by existing compose window or overlay)"
    };
  }

  const recipientAdded = await addRecipient(conn, toEmail, undefined, draftKey);
  if (!recipientAdded) {
    return { success: false, error: "Failed to add forward recipient" };
  }

  if (body) {
    const bodySet = await setBody(conn, textToHtml(body), draftKey);
    if (!bodySet) {
      return { success: false, error: "Failed to set forward body" };
    }
  }

  if (send) {
    // Get the thread info to send via API with proper threading
    const threadInfo = await getThreadInfoForReply(conn, threadId);
    if (!threadInfo) {
      return { success: false, error: "Could not get thread information for forward" };
    }

    // Build subject with Fwd: prefix
    const subject = threadInfo.subject.startsWith("Fwd:")
      ? threadInfo.subject
      : `Fwd: ${threadInfo.subject}`;

    // Get the body content that was set in the draft (includes forwarded content)
    const { Runtime } = conn;
    const draftBody = await Runtime.evaluate({
      expression: `
        (() => {
          try {
            const cfc = window.ViewState?._composeFormController;
            if (!cfc) return null;
            const draftKey = ${JSON.stringify(draftKey)};
            const ctrl = cfc[draftKey];
            const draft = ctrl?.state?.draft;
            return draft?.body || '';
          } catch (e) {
            return '';
          }
        })()
      `,
      returnByValue: true,
    });

    const fullBody = draftBody.result.value as string || body;

    // Send via API
    const result = await sendEmail(conn, {
      to: [toEmail],
      subject,
      body: fullBody,
      isHtml: true,
    });

    if (result.success) {
      return { success: true, messageId: result.messageId };
    }
    return { success: false, error: result.error };
  }

  return saveDraftAndClose(conn, draftKey);
}
