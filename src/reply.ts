/**
 * Reply Module
 *
 * Functions for replying to and forwarding email threads.
 * Routes through SuperhumanProvider (direct backend).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";
import { textToHtml } from "./superhuman-api.js";
import {
  getUserInfoFromCache,
  createDraftWithUserInfo,
  sendDraftSuperhuman,
} from "./draft-api";

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
  if (provider instanceof SuperhumanProvider) {
    return replyViaSuperhuman(provider, threadId, body, send, replyAll);
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Fetch the last message's RFC822 ID and references from a thread.
 * Used to populate In-Reply-To / References threading headers.
 */
async function fetchThreadReplyMeta(
  provider: SuperhumanProvider,
  threadId: string
): Promise<{ messageId: string | null; references: string[] }> {
  try {
    const data = await provider.backendFetch("/v3/userdata.getThreads", {
      method: "POST",
      body: JSON.stringify({
        filter: { threadIds: [threadId] },
        offset: 0,
        limit: 1,
      }),
    });
    if (!data?.threadList?.[0]?.thread?.messages) {
      return { messageId: null, references: [] };
    }
    const msgs = Object.values(data.threadList[0].thread.messages) as any[];
    if (msgs.length === 0) return { messageId: null, references: [] };
    // Sort ascending by date to get the last (most recent) message
    msgs.sort((a: any, b: any) => new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime());
    const last = msgs[msgs.length - 1];
    const msg = last.message || last.draft || last;
    return {
      messageId: msg.rfc822Id || msg.messageId || null,
      references: Array.isArray(msg.references) ? msg.references : [],
    };
  } catch {
    return { messageId: null, references: [] };
  }
}

/**
 * Reply via Superhuman backend: create a reply draft, optionally send it.
 */
async function replyViaSuperhuman(
  provider: SuperhumanProvider,
  threadId: string,
  body: string,
  send: boolean,
  _replyAll: boolean
): Promise<ReplyResult> {
  const token = await provider.getToken();
  const email = await provider.getCurrentEmail();
  const userInfo = getUserInfoFromCache(
    token.superhumanToken?.token || token.accessToken,
    email,
    token.accessToken,
    email.split("@")[0]
  );

  // Fetch original thread's last message ID and references for threading headers.
  // Without these, the sent email has no In-Reply-To / References headers and
  // mail clients create a new thread instead of threading with the original.
  const { messageId: inReplyTo, references } = await fetchThreadReplyMeta(
    provider,
    threadId
  );

  const htmlBody = textToHtml(body);

  // Create a reply draft on the existing thread
  const draftResult = await createDraftWithUserInfo(userInfo, {
    body: htmlBody,
    action: "reply",
    inReplyToThreadId: threadId,
    inReplyToRfc822Id: inReplyTo || undefined,
    references,
  });

  if (!draftResult.success || !draftResult.draftId || !draftResult.threadId) {
    return {
      success: false,
      error: draftResult.error || "Failed to create reply draft",
    };
  }

  if (!send) {
    return {
      success: true,
      draftId: draftResult.draftId,
    };
  }

  // Send the reply draft
  const sendResult = await sendDraftSuperhuman(userInfo, {
    draftId: draftResult.draftId,
    threadId: draftResult.threadId,
    to: [], // recipients are set from thread context
    subject: "",
    htmlBody,
    inReplyTo: inReplyTo || undefined,
    references,
  });

  if (!sendResult.success) {
    return { success: false, error: sendResult.error };
  }

  return {
    success: true,
    draftId: draftResult.draftId,
    messageId: draftResult.draftId,
  };
}

/**
 * Forward a thread
 *
 * Fetches the original message content and constructs a forwarded email
 * with proper "Forwarded message" header.
 */
export async function forwardThread(
  provider: ConnectionProvider,
  threadId: string,
  toEmail: string,
  body: string,
  send: boolean = false
): Promise<ReplyResult> {
  if (provider instanceof SuperhumanProvider) {
    return forwardViaSuperhuman(provider, threadId, toEmail, body, send);
  }

  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Forward via Superhuman backend.
 * Reads thread via backendFetch, constructs forward body, creates draft / sends.
 */
async function forwardViaSuperhuman(
  provider: SuperhumanProvider,
  threadId: string,
  toEmail: string,
  body: string,
  send: boolean
): Promise<ReplyResult> {
  const token = await provider.getToken();
  const email = await provider.getCurrentEmail();
  const userInfo = getUserInfoFromCache(
    token.superhumanToken?.token || token.accessToken,
    email,
    token.accessToken,
    email.split("@")[0]
  );

  // Read thread via backend to get subject/snippet for forward header
  const data = await provider.backendFetch("/v3/userdata.getThreads", {
    method: "POST",
    body: JSON.stringify({
      filter: { threadIds: [threadId] },
      offset: 0,
      limit: 1,
    }),
  });

  // Extract last message info from the thread
  let subject = "(no subject)";
  let snippet = "";
  if (data?.threadList?.[0]?.thread?.messages) {
    const msgs = Object.values(data.threadList[0].thread.messages) as any[];
    // Sort by date to get the last message
    msgs.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const last = msgs[msgs.length - 1];
    if (last) {
      subject = last.subject || "(no subject)";
      snippet = last.snippet || "";
    }
  }

  if (!subject.startsWith("Fwd:")) {
    subject = `Fwd: ${subject}`;
  }

  const htmlBody = body ? textToHtml(body) : "";
  const forwardBody = htmlBody
    ? `${htmlBody}<br><br>---------- Forwarded message ---------<br>${snippet}`
    : `---------- Forwarded message ---------<br>${snippet}`;

  // Create forward draft — do NOT pass inReplyToThreadId; a forward is a new
  // email thread (not a reply), so it needs its own generated thread ID.
  const draftResult = await createDraftWithUserInfo(userInfo, {
    to: [toEmail],
    subject,
    body: forwardBody,
    action: "forward",
  });

  if (!draftResult.success || !draftResult.draftId || !draftResult.threadId) {
    return {
      success: false,
      error: draftResult.error || "Failed to create forward draft",
    };
  }

  if (!send) {
    return { success: true, draftId: draftResult.draftId };
  }

  const sendResult = await sendDraftSuperhuman(userInfo, {
    draftId: draftResult.draftId,
    threadId: draftResult.threadId,
    to: [{ email: toEmail }],
    subject,
    htmlBody: forwardBody,
  });

  if (!sendResult.success) {
    return { success: false, error: sendResult.error };
  }

  return {
    success: true,
    draftId: draftResult.draftId,
    messageId: draftResult.draftId,
  };
}
