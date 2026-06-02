/**
 * Direct Superhuman Draft API
 *
 * Creates drafts via /v3/userdata.writeMessage without CDP UI manipulation.
 */

import type { SuperhumanConnection } from "./superhuman-api";

const SUPERHUMAN_BACKEND = "https://mail.superhuman.com/~backend";

/**
 * POST to the Superhuman backend with automatic id-token refresh + retry.
 *
 * The stored bearer (`userInfo.token`) is the provider (Google/Microsoft) ID
 * token Superhuman's backend accepts directly — a JWT with a ~1h TTL. Once it
 * expires, write/AI calls fail with `401 invalid-id-token` until something
 * re-initialises auth. There is NO Firebase refresh token stored and the token
 * is NOT a securetoken JWT, so the only refresh path is the desktop app's
 * `credential.getIDTokenAsync()` reached over CDP via `refreshTokenViaCDP()`.
 *
 * On a 401/403 we refresh once, mutate `userInfo.token` in place (so later
 * calls in the same operation reuse the fresh token), and retry the request
 * a single time. The Authorization header is (re)built here from the current
 * token, so callers may omit it. Imported lazily to avoid a circular import
 * with token-api.
 */
async function backendFetchWithRetry(
  url: string,
  init: RequestInit,
  userInfo: UserInfo
): Promise<Response> {
  const withToken = (token: string): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
  });

  let response = await fetch(url, withToken(userInfo.token));

  if (response.status === 401 || response.status === 403) {
    try {
      const { refreshTokenViaCDP } = await import("./token-api");
      const refreshed = await refreshTokenViaCDP(userInfo.email);
      const newToken = refreshed?.superhumanToken?.token || refreshed?.idToken;
      if (newToken && newToken !== userInfo.token) {
        userInfo.token = newToken;
        response = await fetch(url, withToken(newToken));
      }
    } catch {
      // Refresh unavailable (e.g. the Superhuman desktop app isn't running
      // with --remote-debugging-port). Fall through and let the caller
      // surface the original 401.
    }
  }

  return response;
}

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

/** Normalize a recipient list for a draft value (empty/undefined -> []). */
function formatRecipients(emails?: string[]): string[] {
  return !emails || emails.length === 0 ? [] : emails;
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
  references?: string[];
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
  /** Full Superhuman external user ID for x-superhuman-user-external-id header */
  userExternalId?: string;
  /** Device UUID for x-superhuman-device-id header */
  deviceId?: string;
}

/**
 * Create UserInfo from cached credentials (no CDP needed)
 */
export function getUserInfoFromCache(
  userId: string,
  email: string,
  idToken: string,
  displayName?: string,
  userExternalId?: string,
  deviceId?: string
): UserInfo {
  return {
    userId,
    email,
    token: idToken,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    displayName,
    userExternalId,
    deviceId,
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
    // For new threads (compose/forward), reuse draftId as threadId so
    // messages/send receives thread_id === message_id. For replies, use the
    // original thread's ID to keep the email in the same thread.
    const threadId = options.inReplyToThreadId || draftId;
    const now = new Date().toISOString();

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
      references: options.references || [],
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

    const response = await backendFetchWithRetry(`${SUPERHUMAN_BACKEND}/v3/userdata.writeMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify(requestBody),
    }, userInfo);

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

    const response = await backendFetchWithRetry(`${SUPERHUMAN_BACKEND}/v3/userdata.writeMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify(requestBody),
    }, userInfo);

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
  /** Attachments uploaded via uploadAttachmentSuperhuman() */
  attachments?: SuperhumanAttachment[];
  /** RFC822 Message-ID to reply to */
  inReplyTo?: string;
  /** Reference chain for threading */
  references?: string[];
}

/**
 * Attachment metadata for Superhuman's native send API
 */
export interface SuperhumanAttachment {
  uuid: string;
  name: string;
  type: string; // MIME type
  inline: boolean;
  downloadUrl: string;
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
 * Update an existing draft by writing to its draft path with existing IDs.
 * Core function to update a draft with pre-extracted user info.
 * Can be used with cached credentials (no CDP needed).
 */
/**
 * Fetch the current stored value of a single draft from the backend.
 *
 * `userdata.writeMessage` replaces the WHOLE value at the draft path, so an
 * update must merge against the existing draft — otherwise unspecified fields
 * (To / Subject / CC / references / …) get blanked. Returns the raw draft
 * object, or null if it genuinely can't be located or the backend was
 * unreachable (the caller then REFUSES to overwrite rather than blanking).
 *
 * Draft IDs are globally unique, so we scan the draft set and match by id. The
 * backend rejects limit > 100 with a 400, so we page through in 100s (up to a
 * safety cap) instead of silently missing drafts beyond the first page.
 */
async function fetchDraftValue(
  userInfo: UserInfo,
  draftId: string
): Promise<Record<string, any> | null> {
  const PAGE = 100;
  const MAX_DRAFTS = 1000; // safety cap on pagination
  try {
    for (let offset = 0; offset < MAX_DRAFTS; offset += PAGE) {
      const response = await backendFetchWithRetry(
        `${SUPERHUMAN_BACKEND}/v3/userdata.getThreads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filter: { type: "draft" }, offset, limit: PAGE }),
        },
        userInfo
      );
      if (!response.ok) return null;
      const data: any = await response.json();
      const list: any[] = data.threadList || [];
      for (const th of list) {
        const msg = th?.thread?.messages?.[draftId];
        if (msg?.draft) return msg.draft as Record<string, any>;
      }
      if (list.length < PAGE) break; // last page reached
    }
    return null;
  } catch {
    return null;
  }
}

export async function updateDraftWithUserInfo(
  userInfo: UserInfo,
  threadId: string,
  draftId: string,
  options: DraftOptions
): Promise<boolean> {
  try {
    const now = new Date().toISOString();

    // MERGE, don't replace: writeMessage overwrites the entire draft value, so
    // we must preserve every field the caller did NOT explicitly pass. Fetch the
    // current draft and use it as the base; only fields present in `options`
    // (i.e. flags the user actually passed) override it.
    const existing = await fetchDraftValue(userInfo, draftId);

    // If we cannot read the current draft (not found in the draft set, or the
    // backend was unreachable), REFUSE to write — a blind write here would blank
    // To/Subject/body and silently destroy the draft (the bug this merge fixes).
    if (!existing) {
      throw new Error(
        `Cannot read current state of draft ${draftId} (not found among drafts, ` +
        `or backend unreachable). Refusing to overwrite to avoid blanking ` +
        `To/Subject/body.`
      );
    }

    const pick = <T>(opt: T | undefined, fallback: T): T =>
      opt !== undefined ? opt : fallback;

    const to = options.to !== undefined ? formatRecipients(options.to) : (existing.to ?? []);
    const cc = options.cc !== undefined ? formatRecipients(options.cc) : (existing.cc ?? []);
    const bcc = options.bcc !== undefined ? formatRecipients(options.bcc) : (existing.bcc ?? []);
    const subject = pick(options.subject, existing.subject ?? "");
    const body = pick(options.body, existing.body ?? "");
    const snippet = body.replace(/<[^>]*>/g, "").substring(0, 100);

    const draftValue = {
      // Carry forward any fields we don't explicitly manage (autoDraftKind,
      // strippedAt, unread, quotedContentInlined, …) so an edit never drops them.
      ...existing,
      id: draftId,
      threadId: threadId,
      action: pick(options.action, existing.action ?? "compose"),
      name: existing.name ?? null,
      from: existing.from || `${userInfo.email.split("@")[0]} <${userInfo.email}>`,
      to,
      cc,
      bcc,
      subject,
      body,
      snippet,
      inReplyToRfc822Id: pick(options.inReplyToRfc822Id, existing.inReplyToRfc822Id ?? null),
      labelIds: existing.labelIds ?? ["DRAFT"],
      clientCreatedAt: existing.clientCreatedAt ?? now,
      date: now,
      fingerprint: {
        to: to.join(","),
        cc: cc.join(","),
        attachments: existing.fingerprint?.attachments ?? "",
      },
      lastSessionId: crypto.randomUUID(),
      quotedContent: existing.quotedContent ?? "",
      quotedContentInlined: existing.quotedContentInlined ?? false,
      references: pick(options.references, existing.references ?? []),
      reminder: existing.reminder ?? null,
      // Preserve the message-id across edits (the old code regenerated it).
      rfc822Id: existing.rfc822Id || generateRfc822Id(),
      scheduledFor: existing.scheduledFor ?? null,
      scheduledReplyInterruptedAt: existing.scheduledReplyInterruptedAt ?? null,
      schemaVersion: existing.schemaVersion ?? 3,
      totalComposeSeconds: existing.totalComposeSeconds ?? 0,
      timeZone: existing.timeZone || userInfo.timeZone,
    };

    const requestBody = {
      writes: [
        {
          path: `users/${userInfo.userId}/threads/${threadId}/messages/${draftId}/draft`,
          value: draftValue,
        },
      ],
    };

    const response = await backendFetchWithRetry(`${SUPERHUMAN_BACKEND}/v3/userdata.writeMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify(requestBody),
    }, userInfo);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text}`);
    }

    return true;
  } catch (error) {
    throw new Error(
      `Failed to update draft: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Delete a draft by writing to its discardedAt path.
 * Core function to delete a draft with pre-extracted user info.
 * Can be used with cached credentials (no CDP needed).
 */
export async function deleteDraftWithUserInfo(
  userInfo: UserInfo,
  threadId: string,
  draftId: string
): Promise<boolean> {
  try {
    const now = new Date().toISOString();

    const requestBody = {
      writes: [
        {
          path: `users/${userInfo.userId}/threads/${threadId}/messages/${draftId}/discardedAt`,
          value: now,
        },
      ],
    };

    const response = await backendFetchWithRetry(`${SUPERHUMAN_BACKEND}/v3/userdata.writeMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify(requestBody),
    }, userInfo);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text}`);
    }

    return true;
  } catch (error) {
    throw new Error(
      `Failed to delete draft: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Format recipients for the outgoing_message structure.
 * The messages/send endpoint expects objects {email, name}, not strings.
 * (The _appToBackendDraft transform converts objects→strings for userdata writes,
 * but toJsonRequest() produces objects for the send payload.)
 */
function formatRecipientForSend(recipients: Recipient[]): Array<{ email: string; name?: string }> {
  return recipients.map((r) => ({
    email: r.email,
    ...(r.name ? { name: r.name } : {}),
  }));
}

/**
 * Upload an attachment to Superhuman's backend.
 *
 * This uploads the file content (base64) to /~backend/v3/attachments.upload
 * and returns a download URL. The attachment is then referenced when sending.
 *
 * @param userInfo - User credentials
 * @param draftId - The draft message ID
 * @param threadId - The thread ID
 * @param filename - Original filename
 * @param mimeType - MIME type of the file
 * @param base64Content - File content as base64 string
 * @returns SuperhumanAttachment with uuid and downloadUrl
 */
export async function uploadAttachmentSuperhuman(
  userInfo: UserInfo,
  draftId: string,
  threadId: string,
  filename: string,
  mimeType: string,
  base64Content: string
): Promise<SuperhumanAttachment> {
  const uuid = crypto.randomUUID();

  const payload = {
    draftMessageId: draftId,
    threadId,
    uuid,
    contentType: mimeType,
    content: base64Content,
  };

  const response = await backendFetchWithRetry(`${SUPERHUMAN_BACKEND}/v3/attachments.upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }, userInfo);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Attachment upload failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // Write attachment metadata so the draft shows the attachment in Superhuman UI
  const cid = crypto.randomUUID();
  const metadataBody = {
    writes: [
      {
        path: `users/${userInfo.userId}/threads/${threadId}/messages/${draftId}/attachments/${uuid}`,
        value: {
          uuid,
          cid,
          name: filename,
          type: mimeType,
          fixedPartId: "0",
          messageId: draftId,
          threadId,
          inline: false,
          source: {
            type: "upload-firebase",
            threadId,
            messageId: draftId,
            uuid,
            url: data.downloadUrl,
          },
          discardedAt: null,
          createdAt: new Date().toISOString(),
          size: Buffer.from(base64Content, "base64").length,
        },
      },
    ],
  };

  if (process.env.SH_DEBUG) {
    console.error("DEBUG attachment metadata write:", JSON.stringify(metadataBody, null, 2));
  }

  const metaResp = await backendFetchWithRetry(`${SUPERHUMAN_BACKEND}/v3/userdata.writeMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
    },
    body: JSON.stringify(metadataBody),
  }, userInfo);

  if (!metaResp.ok) {
    const metaText = await metaResp.text();
    throw new Error(`Attachment metadata write failed (${metaResp.status}): ${metaText}`);
  }

  if (process.env.SH_DEBUG) {
    const metaText = await metaResp.clone().text();
    console.error(`DEBUG attachment metadata response: ${metaResp.status} ${metaText}`);
  }

  return {
    uuid,
    name: filename,
    type: mimeType,
    inline: false,
    downloadUrl: data.downloadUrl,
  };
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
    // Superhuman ID format: timestamp-base36 + "." + UUID
    // The backend validates this format and rejects plain UUIDs.
    const tsBase36 = Math.min(Math.max(Date.now(), 36 ** 7), 36 ** 8 - 1).toString(36);
    const superhumanId = `${tsBase36}.${crypto.randomUUID()}`;

    // Build headers matching Superhuman's toJsonRequest() exactly
    const xMailer = "Superhuman Web (2026-04-03T19:06:01Z)";
    const emailHeaders: Array<{ name: string; value: string }> = [
      { name: "X-Mailer", value: xMailer },
      { name: "X-Superhuman-ID", value: superhumanId },
      { name: "X-Superhuman-Draft-ID", value: options.draftId },
    ];
    // Add X-Superhuman-Thread-ID when threadId is a draft ID (matches isDraftId check in app)
    if (options.threadId.startsWith("draft")) {
      emailHeaders.push({ name: "X-Superhuman-Thread-ID", value: options.threadId });
    }
    if (options.inReplyTo) {
      emailHeaders.push({ name: "In-Reply-To", value: options.inReplyTo });
    }
    if (options.references && options.references.length > 0) {
      emailHeaders.push({ name: "References", value: options.references.join(" ") });
    }

    const fromName = userInfo.displayName || userInfo.email.split("@")[0];

    // Build the outgoing_message structure matching toJsonRequest() output exactly.
    // The messages/send endpoint expects from/to/cc/bcc as objects {email, name},
    // NOT as formatted strings "Name <email>".
    const outgoingMessage = {
      headers: emailHeaders,
      superhuman_id: superhumanId,
      rfc822_id: rfc822Id,
      thread_id: options.threadId,
      message_id: options.draftId,
      in_reply_to: options.inReplyTo || null,
      from: { email: userInfo.email, name: fromName },
      to: formatRecipientForSend(options.to),
      cc: formatRecipientForSend(options.cc || []),
      bcc: formatRecipientForSend(options.bcc || []),
      subject: options.subject,
      html_body: options.htmlBody,
      attachments: (options.attachments || []).map((att) => ({
        uuid: att.uuid,
        name: att.name,
        type: att.type,
        inline: att.inline,
        source: {
          type: "upload",
          uuid: att.uuid,
        },
      })),
      scheduled_for: null,
      abort_on_reply: false,
      current_message_ids: [options.draftId],
      mail_merge_recipients: [],
    };

    const requestBody = {
      version: 3,
      outgoing_message: outgoingMessage,
      delay: options.delay ?? 20, // Default to 20 seconds (undo window)
      is_multi_recipient: true, // app always sends true
    };

    // App calls logSend({action:'draft_ready', draft: outgoingMessage}) before sendEmail
    const logBody = {
      action: "draft_ready",
      draft: outgoingMessage,
      superhuman_id: superhumanId,
      draft_message_id: options.draftId,
      draft_thread_id: options.threadId,
      client_sent_at: new Date().toISOString(),
    };
    const shHeaders = {
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Bearer ${userInfo.token}`,
      "Cache-Control": "no-store",
      "x-superhuman-session-id": `background-${crypto.randomUUID()}`,
      "x-superhuman-request-id": crypto.randomUUID(),
      "x-superhuman-user-email": userInfo.email,
      ...(userInfo.userExternalId ? { "x-superhuman-user-external-id": userInfo.userExternalId } : {}),
      ...(userInfo.deviceId ? { "x-superhuman-device-id": userInfo.deviceId } : {}),
      "x-superhuman-version": "2026-04-03T19:06:01Z",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    };
    // App calls logSend before sendEmail
    const logResp = await fetch(`${SUPERHUMAN_BACKEND}/messages/send/log`, {
      method: "POST",
      headers: shHeaders,
      body: JSON.stringify(logBody),
    }).catch(() => null);
    if (process.env.SH_DEBUG && logResp) {
      console.error("DEBUG logSend status:", logResp.status, await logResp.text().catch(() => ""));
    }

    if (process.env.SH_DEBUG) {
      console.error("DEBUG send body:", JSON.stringify(requestBody, null, 2));
    }

    const response = await backendFetchWithRetry(`${SUPERHUMAN_BACKEND}/messages/send`, {
      method: "POST",
      headers: { ...shHeaders, "x-superhuman-request-id": crypto.randomUUID() },
      body: JSON.stringify(requestBody),
    }, userInfo);

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

export interface GmailSendOptions {
  accessToken: string;
  from: string;
  to: Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
  subject: string;
  htmlBody: string;
  /** For replies: the Gmail hex thread ID to keep the email in the same thread */
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface GmailSendResult {
  success: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
}

/**
 * Send an email directly via Gmail REST API (no Superhuman backend needed).
 *
 * Uses the OAuth access token, so it works from the CLI without browser
 * cookies. Bypasses Superhuman's messages/send endpoint which requires
 * browser session cookies and returns 520 from CLI contexts.
 */
export async function sendViaGmailApi(options: GmailSendOptions): Promise<GmailSendResult> {
  try {
    const formatAddr = (r: Recipient) =>
      r.name ? `${r.name} <${r.email}>` : r.email;

    const lines: string[] = [
      "MIME-Version: 1.0",
      `From: ${options.from}`,
      `To: ${options.to.map(formatAddr).join(", ")}`,
    ];
    if (options.cc && options.cc.length > 0) {
      lines.push(`Cc: ${options.cc.map(formatAddr).join(", ")}`);
    }
    if (options.bcc && options.bcc.length > 0) {
      lines.push(`Bcc: ${options.bcc.map(formatAddr).join(", ")}`);
    }
    lines.push(`Subject: ${options.subject}`);
    if (options.inReplyTo) {
      lines.push(`In-Reply-To: ${options.inReplyTo}`);
    }
    if (options.references && options.references.length > 0) {
      lines.push(`References: ${options.references.join(" ")}`);
    }
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("");
    lines.push(options.htmlBody);

    const raw = lines.join("\r\n");
    const base64url = Buffer.from(raw)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const payload: Record<string, string> = { raw: base64url };
    if (options.threadId) {
      payload.threadId = options.threadId;
    }

    const response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.accessToken}`,
        },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Gmail API error ${response.status}: ${text}` };
    }

    const data = await response.json() as { id: string; threadId: string };
    return { success: true, messageId: data.id, threadId: data.threadId };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fetch the HTML body of a Gmail message by its hex message ID.
 * Returns null if the message can't be fetched or has no HTML part.
 */
export async function fetchGmailMessageHtml(
  accessToken: string,
  gmailMessageId: string
): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!resp.ok) return null;
    const msg = await resp.json() as any;
    return extractHtmlFromPayload(msg.payload) ?? extractTextFromPayload(msg.payload);
  } catch {
    return null;
  }
}

function extractHtmlFromPayload(payload: any): string | null {
  if (!payload) return null;
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  for (const part of payload.parts ?? []) {
    const result = extractHtmlFromPayload(part);
    if (result) return result;
  }
  return null;
}

function extractTextFromPayload(payload: any): string | null {
  if (!payload) return null;
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    const text = Buffer.from(payload.body.data, "base64url").toString("utf8");
    return `<pre style="font-family:sans-serif;white-space:pre-wrap">${text.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  }
  for (const part of payload.parts ?? []) {
    const result = extractTextFromPayload(part);
    if (result) return result;
  }
  return null;
}

/**
 * Build a forwarded email HTML body with the standard forwarded message header.
 */
export function buildForwardBody(
  userText: string,
  originalHtml: string,
  meta: { from: string; date: string | null; subject: string; to: string[] }
): string {
  const dateStr = meta.date
    ? new Date(meta.date).toLocaleString("en-US", {
        weekday: "short", year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
      })
    : "";

  const header = [
    `<div>---------- Forwarded message ---------</div>`,
    `<div>From: ${meta.from}</div>`,
    dateStr ? `<div>Date: ${dateStr}</div>` : "",
    `<div>Subject: ${meta.subject}</div>`,
    meta.to.length ? `<div>To: ${meta.to.join(", ")}</div>` : "",
  ].filter(Boolean).join("\n");

  const prefix = userText ? `${userText}<br><br>` : "";
  return `${prefix}${header}<br>${originalHtml}`;
}
