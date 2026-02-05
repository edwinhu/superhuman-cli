/**
 * Direct Superhuman Draft API
 *
 * Creates drafts via /v3/userdata.writeMessage without CDP UI manipulation.
 */

import { SuperhumanConnection } from "./superhuman-api";

const SUPERHUMAN_BACKEND = "https://mail.superhuman.com/~backend";

/**
 * Generate a draft ID in Superhuman's format: "draft00" + 14 hex chars
 */
function generateDraftId(): string {
  const hex = Array.from({ length: 14 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
  return `draft00${hex}`;
}

/**
 * Generate an RFC822 Message-ID
 */
function generateRfc822Id(): string {
  const random = Math.random().toString(36).substring(2, 10);
  const uuid = crypto.randomUUID();
  return `<${random}.${uuid}@we.are.superhuman.com>`;
}

export interface DraftOptions {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string; // HTML body
  action?: "compose" | "reply" | "forward";
  inReplyToThreadId?: string;
  inReplyToRfc822Id?: string;
}

export interface DraftResult {
  success: boolean;
  draftId?: string;
  threadId?: string;
  error?: string;
}

export interface UserInfo {
  userId: string;
  email: string;
  token: string;
  timeZone: string;
  displayName?: string;
}

/**
 * Create UserInfo from cached credentials (no CDP needed)
 */
export function getUserInfoFromCache(
  userId: string,
  email: string,
  idToken: string,
  displayName?: string
): UserInfo {
  return {
    userId,
    email,
    token: idToken,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    displayName,
  };
}

/**
 * Extract user info and token needed for direct API calls (via CDP)
 */
export async function getUserInfo(conn: SuperhumanConnection): Promise<UserInfo> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const ga = window.GoogleAccount;
          const credential = ga?.credential;
          const authData = credential?._authData;
          const user = credential?.user;

          if (!authData?.idToken) {
            return { error: "Could not extract token" };
          }

          return {
            userId: user?._id,
            email: ga?.emailAddress,
            token: authData.idToken,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
          };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
  });

  const value = result.result.value as UserInfo | { error: string };

  if ("error" in value) {
    throw new Error(`Failed to get user info: ${value.error}`);
  }

  return value;
}

/**
 * Core function to create a draft with pre-extracted user info.
 * Can be used with cached credentials (no CDP needed).
 */
export async function createDraftWithUserInfo(
  userInfo: UserInfo,
  options: DraftOptions
): Promise<DraftResult> {
  try {
    const draftId = generateDraftId();
    const threadId = options.inReplyToThreadId || generateDraftId();
    const now = new Date().toISOString();

    // Format recipients
    const formatRecipients = (emails?: string[]): string[] => {
      if (!emails || emails.length === 0) return [];
      return emails;
    };

    const draftValue = {
      id: draftId,
      threadId: threadId,
      action: options.action || "compose",
      name: null,
      from: `${userInfo.email.split("@")[0]} <${userInfo.email}>`,
      to: formatRecipients(options.to),
      cc: formatRecipients(options.cc),
      bcc: formatRecipients(options.bcc),
      subject: options.subject || "",
      body: options.body || "",
      snippet: (options.body || "").replace(/<[^>]*>/g, "").substring(0, 100),
      inReplyToRfc822Id: options.inReplyToRfc822Id || null,
      labelIds: ["DRAFT"],
      clientCreatedAt: now,
      date: now,
      fingerprint: {
        to: (options.to || []).join(","),
        cc: (options.cc || []).join(","),
        attachments: "",
      },
      lastSessionId: crypto.randomUUID(),
      quotedContent: "",
      quotedContentInlined: false,
      references: [],
      reminder: null,
      rfc822Id: generateRfc822Id(),
      scheduledFor: null,
      scheduledReplyInterruptedAt: null,
      schemaVersion: 3,
      totalComposeSeconds: 0,
      timeZone: userInfo.timeZone,
    };

    const requestBody = {
      writes: [
        {
          path: `users/${userInfo.userId}/threads/${threadId}/messages/${draftId}/draft`,
          value: draftValue,
        },
      ],
    };

    const response = await fetch(`${SUPERHUMAN_BACKEND}/v3/userdata.writeMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        Authorization: `Bearer ${userInfo.token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `API error ${response.status}: ${text}`,
      };
    }

    return {
      success: true,
      draftId,
      threadId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create a draft directly via Superhuman API (extracts credentials via CDP)
 */
export async function createDraftDirect(
  conn: SuperhumanConnection,
  options: DraftOptions
): Promise<DraftResult> {
  const userInfo = await getUserInfo(conn);
  return createDraftWithUserInfo(userInfo, options);
}

/**
 * Update an existing draft
 */
export async function updateDraftDirect(
  conn: SuperhumanConnection,
  draftId: string,
  threadId: string,
  options: DraftOptions
): Promise<DraftResult> {
  try {
    const userInfo = await getUserInfo(conn);
    const now = new Date().toISOString();

    const draftValue = {
      id: draftId,
      threadId: threadId,
      action: options.action || "compose",
      name: null,
      from: `${userInfo.email.split("@")[0]} <${userInfo.email}>`,
      to: options.to || [],
      cc: options.cc || [],
      bcc: options.bcc || [],
      subject: options.subject || "",
      body: options.body || "",
      snippet: (options.body || "").replace(/<[^>]*>/g, "").substring(0, 100),
      inReplyToRfc822Id: options.inReplyToRfc822Id || null,
      labelIds: ["DRAFT"],
      clientCreatedAt: now,
      date: now,
      fingerprint: {
        to: (options.to || []).join(","),
        cc: (options.cc || []).join(","),
        attachments: "",
      },
      lastSessionId: crypto.randomUUID(),
      quotedContent: "",
      quotedContentInlined: false,
      references: [],
      reminder: null,
      rfc822Id: generateRfc822Id(),
      scheduledFor: null,
      scheduledReplyInterruptedAt: null,
      schemaVersion: 3,
      totalComposeSeconds: 0,
      timeZone: userInfo.timeZone,
    };

    const requestBody = {
      writes: [
        {
          path: `users/${userInfo.userId}/threads/${threadId}/messages/${draftId}/draft`,
          value: draftValue,
        },
      ],
    };

    const response = await fetch(`${SUPERHUMAN_BACKEND}/v3/userdata.writeMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        Authorization: `Bearer ${userInfo.token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `API error ${response.status}: ${text}`,
      };
    }

    return {
      success: true,
      draftId,
      threadId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// =============================================================================
// Send Draft via Superhuman Backend
// =============================================================================

/**
 * Recipient with email and optional name
 */
export interface Recipient {
  email: string;
  name?: string;
}

/**
 * Options for sending a draft via Superhuman's native send endpoint
 */
export interface SendDraftOptions {
  /** Draft ID (e.g., "draft00xxxxxx") */
  draftId: string;
  /** Thread ID (usually same as draftId for new messages) */
  threadId: string;
  /** Primary recipients */
  to: Recipient[];
  /** CC recipients (optional) */
  cc?: Recipient[];
  /** BCC recipients (optional) */
  bcc?: Recipient[];
  /** Email subject */
  subject: string;
  /** HTML body content */
  htmlBody: string;
  /** Delay in seconds: 0=immediate, 20=default undo window, 3600=1hr scheduled */
  delay?: number;
}

/**
 * Result of sending a draft
 */
export interface SendDraftResult {
  success: boolean;
  /** Unix timestamp (ms) when email will be sent */
  sendAt?: number;
  error?: string;
}

/**
 * Format recipients for the outgoing_message structure
 */
function formatRecipientForSend(recipients: Recipient[]): Array<{ email: string; name: string }> {
  return recipients.map((r) => ({
    email: r.email,
    name: r.name || "",
  }));
}

/**
 * Send a draft via Superhuman's native /messages/send endpoint.
 *
 * This sends emails through Superhuman's backend rather than Gmail/MS Graph directly.
 * Supports scheduled sending via the delay parameter.
 *
 * @param userInfo - User credentials from getUserInfoFromCache()
 * @param options - Draft content and send options
 * @returns Result with sendAt timestamp on success
 */
export async function sendDraftSuperhuman(
  userInfo: UserInfo,
  options: SendDraftOptions
): Promise<SendDraftResult> {
  try {
    const rfc822Id = generateRfc822Id();
    const superhumanId = crypto.randomUUID();

    // Build the outgoing_message structure per Superhuman's API format
    const outgoingMessage = {
      headers: [],
      superhuman_id: superhumanId,
      rfc822_id: rfc822Id,
      thread_id: options.threadId,
      message_id: options.draftId,
      from: {
        email: userInfo.email,
        name: userInfo.displayName || userInfo.email.split("@")[0],
      },
      to: formatRecipientForSend(options.to),
      cc: formatRecipientForSend(options.cc || []),
      bcc: formatRecipientForSend(options.bcc || []),
      subject: options.subject,
      html_body: options.htmlBody,
      attachments: [],
      abort_on_reply: false,
      current_message_ids: [options.draftId],
      mail_merge_recipients: [],
    };

    const requestBody = {
      version: 3,
      outgoing_message: outgoingMessage,
      delay: options.delay ?? 20, // Default to 20 seconds (undo window)
      is_multi_recipient: options.to.length > 1,
    };

    const response = await fetch(`${SUPERHUMAN_BACKEND}/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userInfo.token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `API error ${response.status}: ${text}`,
      };
    }

    const data = await response.json();
    return {
      success: true,
      sendAt: data.send_at,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
