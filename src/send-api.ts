/**
 * Send API Module
 *
 * Direct email sending via Gmail API and Microsoft Graph API.
 * Bypasses the unreliable UI-based approach for faster, more reliable sending.
 *
 * Gmail: Uses gmail._postAsync() to call POST /gmail/v1/users/me/messages/send
 * Microsoft Graph: Uses msgraph._fetchJSONWithRetry() to call POST /me/sendMail
 */

import type { SuperhumanConnection } from "./superhuman-api";

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
 * Account type detection result
 */
export interface AccountInfo {
  email: string;
  isMicrosoft: boolean;
  provider: "google" | "microsoft";
}

/**
 * Detect the account type (Google or Microsoft)
 */
export async function getAccountInfo(
  conn: SuperhumanConnection
): Promise<AccountInfo | null> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const isMicrosoft = di?.get?.('isMicrosoft') || false;
          return {
            email: ga?.emailAddress || ga?.account?.emailAddress || '',
            isMicrosoft,
            provider: isMicrosoft ? 'microsoft' : 'google'
          };
        } catch (e) {
          return null;
        }
      })()
    `,
    returnByValue: true,
  });

  return result.result.value as AccountInfo | null;
}

/**
 * Send email via Gmail API
 *
 * Uses gmail._postAsync() to send directly through Gmail's REST API.
 * Builds RFC 2822 formatted email and base64url encodes it.
 *
 * @param conn - The Superhuman connection
 * @param options - Email options (to, subject, body, threading info)
 * @returns Result with messageId on success
 */
export async function sendEmailGmail(
  conn: SuperhumanConnection,
  options: SendEmailOptions
): Promise<SendResult> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const gmail = window.GoogleAccount?.di?.get?.('gmail');
          if (!gmail) {
            return { success: false, error: 'Gmail service not found' };
          }

          // Get sender email from profile
          const profile = await gmail.getProfile();
          const fromEmail = profile?.emailAddress;
          if (!fromEmail) {
            return { success: false, error: 'Could not get sender email' };
          }

          // Parse options
          const to = ${JSON.stringify(options.to)};
          const cc = ${JSON.stringify(options.cc || [])};
          const bcc = ${JSON.stringify(options.bcc || [])};
          const subject = ${JSON.stringify(options.subject)};
          const body = ${JSON.stringify(options.body)};
          const isHtml = ${JSON.stringify(options.isHtml ?? true)};
          const threadId = ${JSON.stringify(options.threadId || null)};
          const inReplyTo = ${JSON.stringify(options.inReplyTo || null)};
          const references = ${JSON.stringify(options.references || [])};

          // Build RFC 2822 email headers
          const headers = [
            'MIME-Version: 1.0',
            'From: ' + fromEmail,
            'To: ' + to.join(', ')
          ];

          if (cc.length > 0) {
            headers.push('Cc: ' + cc.join(', '));
          }

          if (bcc.length > 0) {
            headers.push('Bcc: ' + bcc.join(', '));
          }

          headers.push('Subject: ' + subject);

          // Content type based on whether body is HTML
          if (isHtml) {
            headers.push('Content-Type: text/html; charset=utf-8');
          } else {
            headers.push('Content-Type: text/plain; charset=utf-8');
          }

          // Add threading headers for replies
          if (inReplyTo) {
            // Ensure Message-ID format with angle brackets
            const formattedReplyTo = inReplyTo.startsWith('<') ? inReplyTo : '<' + inReplyTo + '>';
            headers.push('In-Reply-To: ' + formattedReplyTo);
          }

          if (references.length > 0) {
            // Format references with angle brackets if needed
            const formattedRefs = references.map(r =>
              r.startsWith('<') ? r : '<' + r + '>'
            ).join(' ');
            headers.push('References: ' + formattedRefs);
          }

          // Add empty line separator and body
          headers.push('');
          headers.push(body);

          const rawEmail = headers.join('\\r\\n');

          // Base64url encode the email (handle UTF-8 properly)
          const base64Email = btoa(unescape(encodeURIComponent(rawEmail)))
            .replace(/\\+/g, '-')
            .replace(/\\//g, '_')
            .replace(/=+$/, '');

          // Build send payload
          const payload = { raw: base64Email };
          if (threadId) {
            payload.threadId = threadId;
          }

          // Send via Gmail API
          const response = await gmail._postAsync(
            'https://content.googleapis.com/gmail/v1/users/me/messages/send',
            payload,
            { endpoint: 'gmail.users.messages.send', cost: 100 }
          );

          return {
            success: true,
            messageId: response?.id,
            threadId: response?.threadId
          };
        } catch (e) {
          return { success: false, error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  return result.result.value as SendResult;
}

/**
 * Send email via Microsoft Graph API
 *
 * Uses msgraph._fetchJSONWithRetry() to send via Graph API's /me/sendMail endpoint.
 * Builds JSON payload in Microsoft Graph format.
 *
 * @param conn - The Superhuman connection
 * @param options - Email options (to, subject, body, threading info)
 * @returns Result with messageId on success
 */
export async function sendEmailMsgraph(
  conn: SuperhumanConnection,
  options: SendEmailOptions
): Promise<SendResult> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const msgraph = di?.get?.('msgraph');

          if (!msgraph) {
            return { success: false, error: 'Microsoft Graph service not found' };
          }

          if (!msgraph._fetchJSONWithRetry) {
            return { success: false, error: 'msgraph._fetchJSONWithRetry not found' };
          }

          // Parse options
          const to = ${JSON.stringify(options.to)};
          const cc = ${JSON.stringify(options.cc || [])};
          const bcc = ${JSON.stringify(options.bcc || [])};
          const subject = ${JSON.stringify(options.subject)};
          const body = ${JSON.stringify(options.body)};
          const isHtml = ${JSON.stringify(options.isHtml ?? true)};
          const threadId = ${JSON.stringify(options.threadId || null)};
          const inReplyTo = ${JSON.stringify(options.inReplyTo || null)};

          // Build Microsoft Graph message format
          const message = {
            subject: subject,
            body: {
              contentType: isHtml ? 'HTML' : 'Text',
              content: body
            },
            toRecipients: to.map(email => ({
              emailAddress: { address: email }
            }))
          };

          // Add CC recipients
          if (cc.length > 0) {
            message.ccRecipients = cc.map(email => ({
              emailAddress: { address: email }
            }));
          }

          // Add BCC recipients
          if (bcc.length > 0) {
            message.bccRecipients = bcc.map(email => ({
              emailAddress: { address: email }
            }));
          }

          // Note: Microsoft Graph does NOT allow In-Reply-To or References headers
          // (they must start with 'x-' or 'X-')
          // Threading in Outlook is handled automatically by conversationId
          // which Graph matches based on subject line (Re: prefix)
          // So we just need to ensure subject has "Re: " prefix for replies

          // Build the full URL using msgraph._fullURL if available
          let url;
          if (typeof msgraph._fullURL === 'function') {
            url = msgraph._fullURL('/v1.0/me/sendMail', {});
          } else {
            url = 'https://graph.microsoft.com/v1.0/me/sendMail';
          }

          // Send via Microsoft Graph API
          // Use _fetchWithRetry instead of _fetchJSONWithRetry because
          // sendMail returns 202 Accepted with no body (empty response)
          const response = await msgraph._fetchWithRetry(url, {
            method: 'POST',
            body: JSON.stringify({ message: message }),
            headers: { 'Content-Type': 'application/json' },
            endpoint: 'mail.send'
          });

          // sendMail returns 202 Accepted with no body on success
          // Check if response is ok (status 2xx)
          if (response.ok || response.status === 202) {
            return {
              success: true,
              messageId: 'sent',
              threadId: threadId
            };
          } else {
            const errorText = await response.text().catch(() => 'Unknown error');
            return { success: false, error: 'HTTP ' + response.status + ': ' + errorText };
          }
        } catch (e) {
          return { success: false, error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  return result.result.value as SendResult;
}

/**
 * Send email using the appropriate provider (Gmail or Microsoft Graph)
 *
 * Automatically detects the account type and routes to the correct implementation.
 *
 * @param conn - The Superhuman connection
 * @param options - Email options (to, subject, body, threading info)
 * @returns Result with messageId on success
 */
export async function sendEmail(
  conn: SuperhumanConnection,
  options: SendEmailOptions
): Promise<SendResult> {
  // Detect account type
  const accountInfo = await getAccountInfo(conn);

  if (!accountInfo) {
    return { success: false, error: "Could not detect account type" };
  }

  if (accountInfo.isMicrosoft) {
    return sendEmailMsgraph(conn, options);
  } else {
    return sendEmailGmail(conn, options);
  }
}

/**
 * Thread info result type
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

/**
 * Get thread information for constructing a reply
 *
 * Retrieves the Message-ID and References headers from the last message
 * in a thread, which are needed for proper email threading.
 * Also includes recipient information for reply-all support.
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to get info for
 * @returns Threading info or null if not found
 */
export async function getThreadInfoForReply(
  conn: SuperhumanConnection,
  threadId: string
): Promise<ThreadInfoForReply | null> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const ga = window.GoogleAccount;
          const thread = ga?.threads?.identityMap?.get?.(${JSON.stringify(threadId)});

          if (!thread?._threadModel) {
            return null;
          }

          const model = thread._threadModel;
          const messages = model.messages || [];
          const lastMsg = messages[messages.length - 1];

          if (!lastMsg) {
            return null;
          }

          // Get the Message-ID of the last message (for In-Reply-To)
          const lastMessageId = lastMsg.rawJson?.messageId ||
                               lastMsg.rawJson?.rfc822Id ||
                               lastMsg.rawJson?.['Message-ID'] ||
                               null;

          // Get existing References and add the last Message-ID
          const existingRefs = lastMsg.rawJson?.references || [];
          const references = Array.isArray(existingRefs) ? existingRefs :
                            (existingRefs ? [existingRefs] : []);

          // Add the last message ID to references if available
          if (lastMessageId && !references.includes(lastMessageId)) {
            references.push(lastMessageId);
          }

          // Get the reply-to address (original sender)
          const replyTo = lastMsg.from?.email || null;

          // Get all recipients for reply-all
          const allTo = (lastMsg.to || []).map(r => r.email).filter(Boolean);
          const allCc = (lastMsg.cc || []).map(r => r.email).filter(Boolean);

          // Get current user's email to exclude from recipients
          const myEmail = ga?.emailAddress || ga?.account?.emailAddress || null;

          return {
            threadId: model.id,
            subject: model.subject || '',
            lastMessageId,
            references,
            replyTo,
            allTo,
            allCc,
            myEmail
          };
        } catch (e) {
          return null;
        }
      })()
    `,
    returnByValue: true,
  });

  return result.result.value as ThreadInfoForReply | null;
}

/**
 * Send a reply via Microsoft Graph using the createReply endpoint
 *
 * This uses the proper Microsoft Graph reply flow:
 * 1. POST /me/messages/{messageId}/createReply (or createReplyAll) to create a reply draft
 * 2. PATCH /me/messages/{draftId} to update the body
 * 3. POST /me/messages/{draftId}/send to send the reply
 *
 * This ensures proper conversation threading in Outlook.
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to reply to
 * @param body - The reply body
 * @param options - Additional options (replyAll, cc, bcc, isHtml)
 * @returns Result with messageId on success
 */
export async function sendReplyMsgraph(
  conn: SuperhumanConnection,
  threadId: string,
  body: string,
  options?: {
    replyAll?: boolean;
    cc?: string[];
    bcc?: string[];
    isHtml?: boolean;
  }
): Promise<SendResult> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const threadId = ${JSON.stringify(threadId)};
          const body = ${JSON.stringify(body)};
          const replyAll = ${JSON.stringify(options?.replyAll ?? false)};
          const cc = ${JSON.stringify(options?.cc || [])};
          const bcc = ${JSON.stringify(options?.bcc || [])};
          const isHtml = ${JSON.stringify(options?.isHtml ?? true)};

          const ga = window.GoogleAccount;
          const di = ga?.di;
          const msgraph = di?.get?.('msgraph');

          if (!msgraph) {
            return { success: false, error: 'Microsoft Graph service not found' };
          }

          if (!msgraph._fetchJSONWithRetry) {
            return { success: false, error: 'msgraph._fetchJSONWithRetry not found' };
          }

          // Get the thread from identity map to find the last message ID
          const thread = ga?.threads?.identityMap?.get?.(threadId);
          if (!thread?._threadModel) {
            return { success: false, error: 'Thread not found' };
          }

          const model = thread._threadModel;

          // Get the last message ID (Microsoft Graph ID, not RFC 2822 Message-ID)
          // messageIds array contains the Graph API message IDs
          const messageIds = model.messageIds || [];
          const lastMessageId = messageIds[messageIds.length - 1];

          if (!lastMessageId) {
            // Fallback: try to get from messages array
            const messages = model.messages || [];
            const lastMsg = messages[messages.length - 1];
            if (!lastMsg?.id) {
              return { success: false, error: 'Could not find last message ID' };
            }
            // Note: lastMsg.id might be the same as messageIds entry
          }

          const messageIdToReply = lastMessageId || model.messages?.[model.messages.length - 1]?.id;
          if (!messageIdToReply) {
            return { success: false, error: 'Could not determine message ID for reply' };
          }

          // Step 1: Create reply draft using createReply or createReplyAll endpoint
          const createEndpoint = replyAll ? 'createReplyAll' : 'createReply';
          let createUrl;
          if (typeof msgraph._fullURL === 'function') {
            createUrl = msgraph._fullURL('/v1.0/me/messages/' + messageIdToReply + '/' + createEndpoint, {});
          } else {
            createUrl = 'https://graph.microsoft.com/v1.0/me/messages/' + messageIdToReply + '/' + createEndpoint;
          }

          const draftResponse = await msgraph._fetchJSONWithRetry(createUrl, {
            method: 'POST',
            body: JSON.stringify({}),
            headers: { 'Content-Type': 'application/json' },
            endpoint: 'mail.' + createEndpoint
          });

          if (!draftResponse?.id) {
            return { success: false, error: 'Failed to create reply draft' };
          }

          const draftId = draftResponse.id;

          // Step 2: Update the draft with our body (and any additional recipients)
          let patchUrl;
          if (typeof msgraph._fullURL === 'function') {
            patchUrl = msgraph._fullURL('/v1.0/me/messages/' + draftId, {});
          } else {
            patchUrl = 'https://graph.microsoft.com/v1.0/me/messages/' + draftId;
          }

          const patchBody = {
            body: {
              contentType: isHtml ? 'HTML' : 'Text',
              content: body
            }
          };

          // Add CC recipients if specified
          if (cc.length > 0) {
            patchBody.ccRecipients = cc.map(email => ({
              emailAddress: { address: email }
            }));
          }

          // Add BCC recipients if specified
          if (bcc.length > 0) {
            patchBody.bccRecipients = bcc.map(email => ({
              emailAddress: { address: email }
            }));
          }

          await msgraph._fetchJSONWithRetry(patchUrl, {
            method: 'PATCH',
            body: JSON.stringify(patchBody),
            headers: { 'Content-Type': 'application/json' },
            endpoint: 'mail.update'
          });

          // Step 3: Send the draft
          let sendUrl;
          if (typeof msgraph._fullURL === 'function') {
            sendUrl = msgraph._fullURL('/v1.0/me/messages/' + draftId + '/send', {});
          } else {
            sendUrl = 'https://graph.microsoft.com/v1.0/me/messages/' + draftId + '/send';
          }

          // send endpoint returns 202 Accepted with no body
          const sendResponse = await msgraph._fetchWithRetry(sendUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            endpoint: 'mail.send'
          });

          if (sendResponse.ok || sendResponse.status === 202) {
            return {
              success: true,
              messageId: draftId,
              threadId: threadId
            };
          } else {
            const errorText = await sendResponse.text().catch(() => 'Unknown error');
            return { success: false, error: 'Failed to send reply: HTTP ' + sendResponse.status + ': ' + errorText };
          }
        } catch (e) {
          return { success: false, error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  return result.result.value as SendResult;
}

/**
 * Send a reply to a thread using the direct API
 *
 * Convenience function that gets thread info and sends a properly threaded reply.
 * Supports both reply (to sender only) and reply-all (to all recipients).
 *
 * For Microsoft accounts, uses the proper createReply endpoint for correct threading.
 * For Gmail accounts, uses the standard sendEmail with threading headers.
 *
 * @param conn - The Superhuman connection
 * @param threadId - The thread ID to reply to
 * @param body - The reply body
 * @param options - Additional options (replyAll, cc, bcc)
 * @returns Result with messageId on success
 */
export async function sendReply(
  conn: SuperhumanConnection,
  threadId: string,
  body: string,
  options?: {
    replyAll?: boolean;
    cc?: string[];
    bcc?: string[];
    isHtml?: boolean;
  }
): Promise<SendResult> {
  // Detect account type first
  const accountInfo = await getAccountInfo(conn);

  // For Microsoft accounts, use the createReply endpoint for proper threading
  if (accountInfo?.isMicrosoft) {
    return sendReplyMsgraph(conn, threadId, body, options);
  }

  // Gmail flow: Get thread info for proper threading
  const threadInfo = await getThreadInfoForReply(conn, threadId);

  if (!threadInfo) {
    return { success: false, error: "Could not get thread information" };
  }

  if (!threadInfo.replyTo) {
    return { success: false, error: "Could not determine reply-to address" };
  }

  // Build subject with Re: prefix if not already present
  const subject = threadInfo.subject.startsWith("Re:")
    ? threadInfo.subject
    : `Re: ${threadInfo.subject}`;

  // Build recipient lists
  let toRecipients: string[];
  let ccRecipients: string[] | undefined = options?.cc;

  if (options?.replyAll) {
    // For reply-all: include original sender + all To recipients (except self)
    // Move original Cc recipients to Cc
    const myEmail = threadInfo.myEmail?.toLowerCase();

    // To: original sender + all original To (excluding self)
    toRecipients = [threadInfo.replyTo];
    for (const email of threadInfo.allTo) {
      if (email.toLowerCase() !== myEmail && !toRecipients.includes(email)) {
        toRecipients.push(email);
      }
    }

    // Cc: original Cc recipients (excluding self and those already in To)
    const toSet = new Set(toRecipients.map((e) => e.toLowerCase()));
    const additionalCc = threadInfo.allCc.filter(
      (email) =>
        email.toLowerCase() !== myEmail && !toSet.has(email.toLowerCase())
    );

    if (additionalCc.length > 0) {
      ccRecipients = [...(options?.cc || []), ...additionalCc];
    }
  } else {
    // Simple reply: just to the original sender
    toRecipients = [threadInfo.replyTo];
  }

  const sendOptions: SendEmailOptions = {
    to: toRecipients,
    cc: ccRecipients,
    bcc: options?.bcc,
    subject,
    body,
    isHtml: options?.isHtml ?? true,
    threadId: threadInfo.threadId,
    inReplyTo: threadInfo.lastMessageId || undefined,
    references: threadInfo.references,
  };

  return sendEmailGmail(conn, sendOptions);
}
