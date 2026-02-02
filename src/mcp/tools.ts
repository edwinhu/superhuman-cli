/**
 * MCP Tools Definition
 *
 * Defines the MCP tools that wrap Superhuman automation functions.
 */

import { z } from "zod";
import {
  connectToSuperhuman,
  openCompose,
  addRecipient,
  setSubject,
  setBody,
  saveDraft,
  sendDraft,
  disconnect,
  getDraftState,
  textToHtml,
  type SuperhumanConnection,
} from "../superhuman-api";
import { listInbox, searchInbox } from "../inbox";
import { readThread } from "../read";
import { listAccounts, switchAccount } from "../accounts";
import { replyToThread, replyAllToThread, forwardThread } from "../reply";
import { archiveThread, deleteThread } from "../archive";
import { markAsRead, markAsUnread } from "../read-status";
import { listLabels, getThreadLabels, addLabel, removeLabel, starThread, unstarThread, listStarred } from "../labels";
import { snoozeThread, unsnoozeThread, listSnoozed, parseSnoozeTime } from "../snooze";
import { listAttachments, downloadAttachment, addAttachment } from "../attachments";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent as deleteCalendarEvent,
  getFreeBusy,
  type CreateEventInput,
  type UpdateEventInput,
} from "../calendar";

const CDP_PORT = 9333;

/**
 * Shared schema for email composition (draft and send use the same fields)
 */
export const EmailSchema = z.object({
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body content (plain text or HTML)"),
  cc: z.string().optional().describe("CC recipient email address (optional)"),
  bcc: z.string().optional().describe("BCC recipient email address (optional)"),
});

export const DraftSchema = EmailSchema;
export const SendSchema = EmailSchema;

/**
 * Zod schema for inbox search parameters
 */
export const SearchSchema = z.object({
  query: z.string().describe("Search query string"),
  limit: z.number().optional().describe("Maximum number of results to return (default: 10)"),
});

/**
 * Zod schema for inbox listing
 */
export const InboxSchema = z.object({
  limit: z.number().optional().describe("Maximum number of threads to return (default: 10)"),
});

/**
 * Zod schema for reading a thread
 */
export const ReadSchema = z.object({
  threadId: z.string().describe("The thread ID to read"),
});

/**
 * Zod schema for listing accounts (no parameters)
 */
export const AccountsSchema = z.object({});

/**
 * Zod schema for switching accounts
 */
export const SwitchAccountSchema = z.object({
  account: z.string().describe("Account to switch to: either an email address or 1-based index number"),
});

/**
 * Zod schema for reply to a thread
 */
export const ReplySchema = z.object({
  threadId: z.string().describe("Thread ID to reply to"),
  body: z.string().describe("Reply message body"),
  send: z.boolean().optional().describe("Send immediately instead of creating draft (default: false)"),
});

/**
 * Zod schema for reply-all to a thread
 */
export const ReplyAllSchema = z.object({
  threadId: z.string().describe("Thread ID to reply-all to"),
  body: z.string().describe("Reply message body"),
  send: z.boolean().optional().describe("Send immediately instead of creating draft (default: false)"),
});

/**
 * Zod schema for forwarding a thread
 */
export const ForwardSchema = z.object({
  threadId: z.string().describe("Thread ID to forward"),
  toEmail: z.string().describe("Email address to forward to"),
  body: z.string().describe("Message body to include before the forwarded content"),
  send: z.boolean().optional().describe("Send immediately instead of creating draft (default: false)"),
});

/**
 * Zod schema for archiving threads
 */
export const ArchiveSchema = z.object({
  threadIds: z.array(z.string()).describe("Thread ID(s) to archive"),
});

/**
 * Zod schema for deleting threads
 */
export const DeleteSchema = z.object({
  threadIds: z.array(z.string()).describe("Thread ID(s) to delete (move to trash)"),
});

/**
 * Zod schema for marking threads as read
 */
export const MarkReadSchema = z.object({
  threadIds: z.array(z.string()).describe("Thread ID(s) to mark as read"),
});

/**
 * Zod schema for marking threads as unread
 */
export const MarkUnreadSchema = z.object({
  threadIds: z.array(z.string()).describe("Thread ID(s) to mark as unread"),
});

/**
 * Zod schema for listing labels (no parameters)
 */
export const LabelsSchema = z.object({});

/**
 * Zod schema for getting labels on a thread
 */
export const GetLabelsSchema = z.object({
  threadId: z.string().describe("The thread ID to get labels for"),
});

/**
 * Zod schema for adding a label to threads
 */
export const AddLabelSchema = z.object({
  threadIds: z.array(z.string()).describe("Thread ID(s) to add the label to"),
  labelId: z.string().describe("The label ID to add"),
});

/**
 * Zod schema for removing a label from threads
 */
export const RemoveLabelSchema = z.object({
  threadIds: z.array(z.string()).describe("Thread ID(s) to remove the label from"),
  labelId: z.string().describe("The label ID to remove"),
});

/**
 * Zod schema for starring threads
 */
export const StarSchema = z.object({
  threadIds: z.array(z.string()).describe("Thread ID(s) to star"),
});

/**
 * Zod schema for unstarring threads
 */
export const UnstarSchema = z.object({
  threadIds: z.array(z.string()).describe("Thread ID(s) to unstar"),
});

/**
 * Zod schema for listing starred threads
 */
export const StarredSchema = z.object({
  limit: z.number().optional().describe("Maximum number of starred threads to return (default: 50)"),
});

/**
 * Zod schema for snoozing threads
 */
export const SnoozeSchema = z.object({
  threadIds: z.array(z.string()).describe("Thread ID(s) to snooze"),
  until: z.string().describe("When to unsnooze: preset (tomorrow, next-week, weekend, evening) or ISO datetime (e.g., 2024-02-15T14:00:00Z)"),
});

/**
 * Zod schema for unsnoozing threads
 */
export const UnsnoozeSchema = z.object({
  threadIds: z.array(z.string()).describe("Thread ID(s) to unsnooze"),
});

/**
 * Zod schema for listing snoozed threads
 */
export const SnoozedSchema = z.object({
  limit: z.number().optional().describe("Maximum number of snoozed threads to return (default: 50)"),
});

/**
 * Zod schema for listing attachments in a thread
 */
export const AttachmentsSchema = z.object({
  threadId: z.string().describe("The thread ID to list attachments for"),
});

/**
 * Zod schema for downloading an attachment
 */
export const DownloadAttachmentSchema = z.object({
  messageId: z.string().describe("The message ID containing the attachment"),
  attachmentId: z.string().describe("The attachment ID to download"),
  threadId: z.string().optional().describe("The thread ID (optional, helps with some providers)"),
  mimeType: z.string().optional().describe("The MIME type of the attachment (optional)"),
});

/**
 * Zod schema for adding an attachment to current draft
 */
export const AddAttachmentSchema = z.object({
  filename: z.string().describe("The filename for the attachment"),
  data: z.string().describe("The file content as a base64-encoded string"),
  mimeType: z.string().describe("The MIME type of the file (e.g., 'application/pdf', 'image/png')"),
});

/**
 * Zod schema for listing calendar events
 */
export const CalendarListSchema = z.object({
  date: z.string().optional().describe("Start date (YYYY-MM-DD or 'today', 'tomorrow'). Defaults to today."),
  range: z.number().optional().describe("Number of days to show (default: 1)"),
});

/**
 * Zod schema for creating a calendar event
 */
export const CalendarCreateSchema = z.object({
  title: z.string().describe("Event title/summary"),
  startTime: z.string().describe("Start time as ISO datetime (e.g., 2026-02-03T14:00:00Z)"),
  endTime: z.string().optional().describe("End time as ISO datetime (optional, defaults to 30 minutes after start)"),
  description: z.string().optional().describe("Event description"),
  attendees: z.array(z.string()).optional().describe("List of attendee email addresses"),
  allDay: z.boolean().optional().describe("Whether this is an all-day event (if true, use date format YYYY-MM-DD for startTime)"),
});

/**
 * Zod schema for updating a calendar event
 */
export const CalendarUpdateSchema = z.object({
  eventId: z.string().describe("The event ID to update"),
  title: z.string().optional().describe("New event title/summary"),
  startTime: z.string().optional().describe("New start time as ISO datetime"),
  endTime: z.string().optional().describe("New end time as ISO datetime"),
  description: z.string().optional().describe("New event description"),
  attendees: z.array(z.string()).optional().describe("New list of attendee email addresses"),
});

/**
 * Zod schema for deleting a calendar event
 */
export const CalendarDeleteSchema = z.object({
  eventId: z.string().describe("The event ID to delete"),
});

/**
 * Zod schema for checking free/busy availability
 */
export const CalendarFreeBusySchema = z.object({
  timeMin: z.string().describe("Start of time range as ISO datetime"),
  timeMax: z.string().describe("End of time range as ISO datetime"),
});

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

function successResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Compose an email (shared logic for draft and send)
 */
async function composeEmail(
  args: z.infer<typeof EmailSchema>
): Promise<{ conn: SuperhumanConnection; draftKey: string }> {
  const conn = await connectToSuperhuman(CDP_PORT);
  if (!conn) {
    throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
  }

  const draftKey = await openCompose(conn);
  if (!draftKey) {
    await disconnect(conn);
    throw new Error("Failed to open compose window");
  }

  await addRecipient(conn, args.to);
  if (args.subject) await setSubject(conn, args.subject);
  if (args.body) await setBody(conn, textToHtml(args.body));

  return { conn, draftKey };
}

/**
 * Handler for superhuman_draft tool
 */
export async function draftHandler(args: z.infer<typeof DraftSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    const composed = await composeEmail(args);
    conn = composed.conn;

    await saveDraft(conn);
    const state = await getDraftState(conn);

    return successResult(
      `Draft created successfully.\nTo: ${args.to}\nSubject: ${args.subject}\nDraft ID: ${state?.id || composed.draftKey}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to create draft: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_send tool
 */
export async function sendHandler(args: z.infer<typeof SendSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    const composed = await composeEmail(args);
    conn = composed.conn;

    const sent = await sendDraft(conn);
    if (!sent) {
      throw new Error("Failed to send email");
    }

    return successResult(`Email sent successfully.\nTo: ${args.to}\nSubject: ${args.subject}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to send email: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_search tool
 */
export async function searchHandler(args: z.infer<typeof SearchSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const { Runtime } = conn;
    const limit = args.limit ?? 10;

    const searchResult = await Runtime.evaluate({
      expression: `
        (async () => {
          try {
            const portal = window.GoogleAccount?.portal;
            if (!portal) return { error: 'Superhuman portal not found' };

            const listResult = await portal.invoke("threadInternal", "listAsync", [
              "INBOX",
              { limit: ${limit}, filters: [], query: ${JSON.stringify(args.query)} }
            ]);

            const threads = listResult?.threads || [];
            return {
              results: threads.slice(0, ${limit}).map(t => {
                const json = t.json || {};
                const shData = t.superhumanData || {};

                let firstMessage = null;
                if (shData.messages && typeof shData.messages === 'object') {
                  const msgKeys = Object.keys(shData.messages);
                  if (msgKeys.length > 0) {
                    const msg = shData.messages[msgKeys[0]];
                    firstMessage = msg.draft || msg;
                  }
                } else if (json.messages && json.messages.length > 0) {
                  firstMessage = json.messages[0];
                }

                return {
                  id: json.id || '',
                  from: firstMessage?.from?.email || '',
                  subject: firstMessage?.subject || json.snippet || '',
                  snippet: firstMessage?.snippet || json.snippet || '',
                  date: firstMessage?.date || firstMessage?.clientCreatedAt || ''
                };
              })
            };
          } catch (err) {
            return { error: err.message };
          }
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });

    const result = searchResult.result.value as {
      results?: Array<{ id: string; from: string; subject: string; snippet: string; date: string }>;
      error?: string;
    };

    if (result.error) {
      throw new Error(result.error);
    }

    const results = result.results || [];

    if (results.length === 0) {
      return successResult(`No results found for query: "${args.query}"`);
    }

    const resultsText = results
      .map((r, i) => `${i + 1}. From: ${r.from}\n   Subject: ${r.subject}\n   Date: ${r.date}\n   Snippet: ${r.snippet}`)
      .join("\n\n");

    return successResult(`Found ${results.length} result(s) for query: "${args.query}"\n\n${resultsText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to search inbox: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_inbox tool
 */
export async function inboxHandler(args: z.infer<typeof InboxSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const threads = await listInbox(conn, { limit: args.limit ?? 10 });

    if (threads.length === 0) {
      return successResult("No emails in inbox");
    }

    const resultsText = threads
      .map((t, i) => {
        const from = t.from.name || t.from.email;
        return `${i + 1}. From: ${from}\n   Subject: ${t.subject}\n   Date: ${t.date}\n   Snippet: ${t.snippet.substring(0, 100)}...`;
      })
      .join("\n\n");

    return successResult(`Inbox (${threads.length} threads):\n\n${resultsText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to list inbox: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_read tool
 */
export async function readHandler(args: z.infer<typeof ReadSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const messages = await readThread(conn, args.threadId);

    if (messages.length === 0) {
      return errorResult(`Thread not found: ${args.threadId}`);
    }

    const messagesText = messages
      .map((msg, i) => {
        const from = msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email;
        const to = msg.to.map(r => r.email).join(", ");
        const cc = msg.cc.length > 0 ? `\nCc: ${msg.cc.map(r => r.email).join(", ")}` : "";
        return `--- Message ${i + 1} ---\nFrom: ${from}\nTo: ${to}${cc}\nDate: ${msg.date}\nSubject: ${msg.subject}\n\n${msg.snippet}`;
      })
      .join("\n\n");

    return successResult(`Thread: ${messages[0].subject}\n\n${messagesText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to read thread: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_accounts tool
 */
export async function accountsHandler(_args: z.infer<typeof AccountsSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const accounts = await listAccounts(conn);

    if (accounts.length === 0) {
      return successResult("No linked accounts found");
    }

    const accountsText = accounts
      .map((a, i) => {
        const marker = a.isCurrent ? "* " : "  ";
        const current = a.isCurrent ? " (current)" : "";
        return `${marker}${i + 1}. ${a.email}${current}`;
      })
      .join("\n");

    return successResult(`Linked accounts:\n\n${accountsText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to list accounts: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_switch_account tool
 */
export async function switchAccountHandler(args: z.infer<typeof SwitchAccountSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    // Get accounts to resolve the target
    const accounts = await listAccounts(conn);

    if (accounts.length === 0) {
      return errorResult("No linked accounts found");
    }

    // Determine target email: either by index (1-based) or by email address
    let targetEmail: string | undefined;
    const indexMatch = args.account.match(/^(\d+)$/);

    if (indexMatch) {
      // It's an index (1-based)
      const index = parseInt(indexMatch[1], 10);
      if (index < 1 || index > accounts.length) {
        return errorResult(`Account index ${index} not found. Valid range: 1-${accounts.length}`);
      }
      targetEmail = accounts[index - 1].email;
    } else {
      // It's an email address
      const account = accounts.find((a) => a.email === args.account);
      if (!account) {
        return errorResult(`Account "${args.account}" not found`);
      }
      targetEmail = account.email;
    }

    // Perform the switch
    const result = await switchAccount(conn, targetEmail);

    if (result.success) {
      return successResult(`Switched to ${result.email}`);
    } else {
      return errorResult(`Failed to switch to ${targetEmail}. Current account: ${result.email}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to switch account: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_reply tool
 */
export async function replyHandler(args: z.infer<typeof ReplySchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const send = args.send ?? false;
    const result = await replyToThread(conn, args.threadId, args.body, send);

    if (!result.success) {
      throw new Error("Failed to create reply");
    }

    if (send) {
      return successResult(`Reply sent successfully to thread ${args.threadId}`);
    } else {
      return successResult(`Reply draft created for thread ${args.threadId}${result.draftId ? `\nDraft ID: ${result.draftId}` : ""}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to reply: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_reply_all tool
 */
export async function replyAllHandler(args: z.infer<typeof ReplyAllSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const send = args.send ?? false;
    const result = await replyAllToThread(conn, args.threadId, args.body, send);

    if (!result.success) {
      throw new Error("Failed to create reply-all");
    }

    if (send) {
      return successResult(`Reply-all sent successfully to thread ${args.threadId}`);
    } else {
      return successResult(`Reply-all draft created for thread ${args.threadId}${result.draftId ? `\nDraft ID: ${result.draftId}` : ""}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to reply-all: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_forward tool
 */
export async function forwardHandler(args: z.infer<typeof ForwardSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const send = args.send ?? false;
    const result = await forwardThread(conn, args.threadId, args.toEmail, args.body, send);

    if (!result.success) {
      throw new Error("Failed to create forward");
    }

    if (send) {
      return successResult(`Email forwarded successfully to ${args.toEmail}`);
    } else {
      return successResult(`Forward draft created for ${args.toEmail}${result.draftId ? `\nDraft ID: ${result.draftId}` : ""}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to forward: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_archive tool
 */
export async function archiveHandler(args: z.infer<typeof ArchiveSchema>): Promise<ToolResult> {
  if (args.threadIds.length === 0) {
    return errorResult("At least one thread ID is required");
  }

  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const results: { threadId: string; success: boolean }[] = [];

    for (const threadId of args.threadIds) {
      const result = await archiveThread(conn, threadId);
      results.push({ threadId, success: result.success });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed === 0) {
      return successResult(`Archived ${succeeded} thread(s) successfully`);
    } else if (succeeded === 0) {
      return errorResult(`Failed to archive all ${failed} thread(s)`);
    } else {
      const failedIds = results.filter((r) => !r.success).map((r) => r.threadId).join(", ");
      return successResult(`Archived ${succeeded} thread(s), failed to archive ${failed}: ${failedIds}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to archive: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_delete tool
 */
export async function deleteHandler(args: z.infer<typeof DeleteSchema>): Promise<ToolResult> {
  if (args.threadIds.length === 0) {
    return errorResult("At least one thread ID is required");
  }

  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const results: { threadId: string; success: boolean }[] = [];

    for (const threadId of args.threadIds) {
      const result = await deleteThread(conn, threadId);
      results.push({ threadId, success: result.success });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed === 0) {
      return successResult(`Deleted ${succeeded} thread(s) successfully`);
    } else if (succeeded === 0) {
      return errorResult(`Failed to delete all ${failed} thread(s)`);
    } else {
      const failedIds = results.filter((r) => !r.success).map((r) => r.threadId).join(", ");
      return successResult(`Deleted ${succeeded} thread(s), failed to delete ${failed}: ${failedIds}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to delete: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_mark_read tool
 */
export async function markReadHandler(args: z.infer<typeof MarkReadSchema>): Promise<ToolResult> {
  if (args.threadIds.length === 0) {
    return errorResult("At least one thread ID is required");
  }

  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const results: { threadId: string; success: boolean }[] = [];

    for (const threadId of args.threadIds) {
      const result = await markAsRead(conn, threadId);
      results.push({ threadId, success: result.success });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed === 0) {
      return successResult(`Marked ${succeeded} thread(s) as read`);
    } else if (succeeded === 0) {
      return errorResult(`Failed to mark all ${failed} thread(s) as read`);
    } else {
      const failedIds = results.filter((r) => !r.success).map((r) => r.threadId).join(", ");
      return successResult(`Marked ${succeeded} thread(s) as read, failed on ${failed}: ${failedIds}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to mark as read: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_mark_unread tool
 */
export async function markUnreadHandler(args: z.infer<typeof MarkUnreadSchema>): Promise<ToolResult> {
  if (args.threadIds.length === 0) {
    return errorResult("At least one thread ID is required");
  }

  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const results: { threadId: string; success: boolean }[] = [];

    for (const threadId of args.threadIds) {
      const result = await markAsUnread(conn, threadId);
      results.push({ threadId, success: result.success });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed === 0) {
      return successResult(`Marked ${succeeded} thread(s) as unread`);
    } else if (succeeded === 0) {
      return errorResult(`Failed to mark all ${failed} thread(s) as unread`);
    } else {
      const failedIds = results.filter((r) => !r.success).map((r) => r.threadId).join(", ");
      return successResult(`Marked ${succeeded} thread(s) as unread, failed on ${failed}: ${failedIds}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to mark as unread: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_labels tool
 */
export async function labelsHandler(_args: z.infer<typeof LabelsSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const labels = await listLabels(conn);

    if (labels.length === 0) {
      return successResult("No labels found");
    }

    const labelsText = labels
      .map((l) => {
        const typeInfo = l.type ? ` (${l.type})` : "";
        return `- ${l.name}${typeInfo}\n  ID: ${l.id}`;
      })
      .join("\n");

    return successResult(`Available labels:\n\n${labelsText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to list labels: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_get_labels tool
 */
export async function getLabelsHandler(args: z.infer<typeof GetLabelsSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const labels = await getThreadLabels(conn, args.threadId);

    if (labels.length === 0) {
      return successResult(`No labels on thread ${args.threadId}`);
    }

    const labelsText = labels
      .map((l) => {
        const typeInfo = l.type ? ` (${l.type})` : "";
        return `- ${l.name}${typeInfo}\n  ID: ${l.id}`;
      })
      .join("\n");

    return successResult(`Labels on thread ${args.threadId}:\n\n${labelsText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to get thread labels: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_add_label tool
 */
export async function addLabelHandler(args: z.infer<typeof AddLabelSchema>): Promise<ToolResult> {
  if (args.threadIds.length === 0) {
    return errorResult("At least one thread ID is required");
  }

  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const results: { threadId: string; success: boolean }[] = [];

    for (const threadId of args.threadIds) {
      const result = await addLabel(conn, threadId, args.labelId);
      results.push({ threadId, success: result.success });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed === 0) {
      return successResult(`Added label to ${succeeded} thread(s)`);
    } else if (succeeded === 0) {
      return errorResult(`Failed to add label to all ${failed} thread(s)`);
    } else {
      const failedIds = results.filter((r) => !r.success).map((r) => r.threadId).join(", ");
      return successResult(`Added label to ${succeeded} thread(s), failed on ${failed}: ${failedIds}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to add label: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_remove_label tool
 */
export async function removeLabelHandler(args: z.infer<typeof RemoveLabelSchema>): Promise<ToolResult> {
  if (args.threadIds.length === 0) {
    return errorResult("At least one thread ID is required");
  }

  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const results: { threadId: string; success: boolean }[] = [];

    for (const threadId of args.threadIds) {
      const result = await removeLabel(conn, threadId, args.labelId);
      results.push({ threadId, success: result.success });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed === 0) {
      return successResult(`Removed label from ${succeeded} thread(s)`);
    } else if (succeeded === 0) {
      return errorResult(`Failed to remove label from all ${failed} thread(s)`);
    } else {
      const failedIds = results.filter((r) => !r.success).map((r) => r.threadId).join(", ");
      return successResult(`Removed label from ${succeeded} thread(s), failed on ${failed}: ${failedIds}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to remove label: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_star tool
 */
export async function starHandler(args: z.infer<typeof StarSchema>): Promise<ToolResult> {
  if (args.threadIds.length === 0) {
    return errorResult("At least one thread ID is required");
  }

  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const results: { threadId: string; success: boolean; error?: string }[] = [];

    for (const threadId of args.threadIds) {
      const result = await starThread(conn, threadId);
      results.push({ threadId, success: result.success, error: result.error });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed === 0) {
      return successResult(`Starred ${succeeded} thread(s)`);
    } else if (succeeded === 0) {
      return errorResult(`Failed to star all ${failed} thread(s)`);
    } else {
      const failedIds = results.filter((r) => !r.success).map((r) => r.threadId).join(", ");
      return successResult(`Starred ${succeeded} thread(s), failed on ${failed}: ${failedIds}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to star: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_unstar tool
 */
export async function unstarHandler(args: z.infer<typeof UnstarSchema>): Promise<ToolResult> {
  if (args.threadIds.length === 0) {
    return errorResult("At least one thread ID is required");
  }

  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const results: { threadId: string; success: boolean; error?: string }[] = [];

    for (const threadId of args.threadIds) {
      const result = await unstarThread(conn, threadId);
      results.push({ threadId, success: result.success, error: result.error });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed === 0) {
      return successResult(`Unstarred ${succeeded} thread(s)`);
    } else if (succeeded === 0) {
      return errorResult(`Failed to unstar all ${failed} thread(s)`);
    } else {
      const failedIds = results.filter((r) => !r.success).map((r) => r.threadId).join(", ");
      return successResult(`Unstarred ${succeeded} thread(s), failed on ${failed}: ${failedIds}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to unstar: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_starred tool
 */
export async function starredHandler(args: z.infer<typeof StarredSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const limit = args.limit ?? 50;
    const threads = await listStarred(conn, limit);

    if (threads.length === 0) {
      return successResult("No starred threads found");
    }

    const threadsText = threads
      .map((t, i) => `${i + 1}. Thread ID: ${t.id}`)
      .join("\n");

    return successResult(`Starred threads (${threads.length}):\n\n${threadsText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to list starred threads: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_snooze tool
 */
export async function snoozeHandler(args: z.infer<typeof SnoozeSchema>): Promise<ToolResult> {
  if (args.threadIds.length === 0) {
    return errorResult("At least one thread ID is required");
  }

  let snoozeTime: Date;
  try {
    snoozeTime = parseSnoozeTime(args.until);
  } catch (e) {
    return errorResult(`Invalid snooze time: ${args.until}`);
  }

  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const results: { threadId: string; success: boolean; error?: string }[] = [];

    for (const threadId of args.threadIds) {
      const result = await snoozeThread(conn, threadId, snoozeTime);
      results.push({ threadId, success: result.success, error: result.error });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed === 0) {
      return successResult(`Snoozed ${succeeded} thread(s) until ${snoozeTime.toISOString()}`);
    } else if (succeeded === 0) {
      return errorResult(`Failed to snooze all ${failed} thread(s)`);
    } else {
      const failedIds = results.filter((r) => !r.success).map((r) => r.threadId).join(", ");
      return successResult(`Snoozed ${succeeded} thread(s), failed on ${failed}: ${failedIds}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to snooze: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_unsnooze tool
 */
export async function unsnoozeHandler(args: z.infer<typeof UnsnoozeSchema>): Promise<ToolResult> {
  if (args.threadIds.length === 0) {
    return errorResult("At least one thread ID is required");
  }

  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const results: { threadId: string; success: boolean; error?: string }[] = [];

    for (const threadId of args.threadIds) {
      const result = await unsnoozeThread(conn, threadId);
      results.push({ threadId, success: result.success, error: result.error });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed === 0) {
      return successResult(`Unsnoozed ${succeeded} thread(s)`);
    } else if (succeeded === 0) {
      return errorResult(`Failed to unsnooze all ${failed} thread(s)`);
    } else {
      const failedIds = results.filter((r) => !r.success).map((r) => r.threadId).join(", ");
      return successResult(`Unsnoozed ${succeeded} thread(s), failed on ${failed}: ${failedIds}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to unsnooze: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_snoozed tool
 */
export async function snoozedHandler(args: z.infer<typeof SnoozedSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const limit = args.limit ?? 50;
    const threads = await listSnoozed(conn, limit);

    if (threads.length === 0) {
      return successResult("No snoozed threads found");
    }

    const threadsText = threads
      .map((t, i) => {
        const untilStr = t.snoozeUntil ? ` (until ${t.snoozeUntil})` : "";
        return `${i + 1}. Thread ID: ${t.id}${untilStr}`;
      })
      .join("\n");

    return successResult(`Snoozed threads (${threads.length}):\n\n${threadsText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to list snoozed threads: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_attachments tool
 */
export async function attachmentsHandler(args: z.infer<typeof AttachmentsSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const attachments = await listAttachments(conn, args.threadId);

    if (attachments.length === 0) {
      return successResult(`No attachments found in thread ${args.threadId}`);
    }

    const attachmentsText = attachments
      .map((att, i) => {
        return `${i + 1}. ${att.name}\n   MIME Type: ${att.mimeType}\n   Attachment ID: ${att.attachmentId}\n   Message ID: ${att.messageId}`;
      })
      .join("\n\n");

    return successResult(`Attachments in thread ${args.threadId} (${attachments.length}):\n\n${attachmentsText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to list attachments: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_download_attachment tool
 */
export async function downloadAttachmentHandler(args: z.infer<typeof DownloadAttachmentSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const content = await downloadAttachment(conn, args.messageId, args.attachmentId, args.threadId, args.mimeType);

    return successResult(JSON.stringify({
      data: content.data,
      size: content.size,
      mimeType: args.mimeType || "application/octet-stream",
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to download attachment: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_add_attachment tool
 */
export async function addAttachmentHandler(args: z.infer<typeof AddAttachmentSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const result = await addAttachment(conn, args.filename, args.data, args.mimeType);

    if (result.success) {
      return successResult(`Attachment "${args.filename}" added to draft successfully`);
    } else {
      return errorResult(`Failed to add attachment: ${result.error || "Unknown error"}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to add attachment: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_calendar_list tool
 */
export async function calendarListHandler(args: z.infer<typeof CalendarListSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    // Parse date
    let timeMin: Date;
    if (args.date) {
      const lowerDate = args.date.toLowerCase();
      if (lowerDate === "today") {
        timeMin = new Date();
        timeMin.setHours(0, 0, 0, 0);
      } else if (lowerDate === "tomorrow") {
        timeMin = new Date();
        timeMin.setDate(timeMin.getDate() + 1);
        timeMin.setHours(0, 0, 0, 0);
      } else {
        timeMin = new Date(args.date);
      }
    } else {
      timeMin = new Date();
      timeMin.setHours(0, 0, 0, 0);
    }

    const range = args.range || 1;
    const timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + range);
    timeMax.setHours(23, 59, 59, 999);

    const events = await listEvents(conn, { timeMin, timeMax });

    return successResult(JSON.stringify(events, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to list calendar events: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_calendar_create tool
 */
export async function calendarCreateHandler(args: z.infer<typeof CalendarCreateSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const startTime = new Date(args.startTime);
    let endTime: Date;
    if (args.endTime) {
      endTime = new Date(args.endTime);
    } else {
      endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // Default 30 minutes
    }

    const eventInput: CreateEventInput = {
      summary: args.title,
      description: args.description,
      start: args.allDay
        ? { date: args.startTime.split("T")[0] }
        : { dateTime: startTime.toISOString() },
      end: args.allDay
        ? { date: endTime.toISOString().split("T")[0] }
        : { dateTime: endTime.toISOString() },
      attendees: args.attendees?.map(email => ({ email })),
    };

    const result = await createEvent(conn, eventInput);

    if (result.success) {
      return successResult(JSON.stringify({
        success: true,
        eventId: result.eventId,
        message: "Event created successfully",
      }));
    } else {
      return errorResult(`Failed to create event: ${result.error}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to create calendar event: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_calendar_update tool
 */
export async function calendarUpdateHandler(args: z.infer<typeof CalendarUpdateSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const updates: UpdateEventInput = {};
    if (args.title) updates.summary = args.title;
    if (args.description) updates.description = args.description;
    if (args.startTime) updates.start = { dateTime: new Date(args.startTime).toISOString() };
    if (args.endTime) updates.end = { dateTime: new Date(args.endTime).toISOString() };
    if (args.attendees) updates.attendees = args.attendees.map(email => ({ email }));

    const result = await updateEvent(conn, args.eventId, updates);

    if (result.success) {
      return successResult(JSON.stringify({
        success: true,
        eventId: result.eventId,
        message: "Event updated successfully",
      }));
    } else {
      return errorResult(`Failed to update event: ${result.error}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to update calendar event: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_calendar_delete tool
 */
export async function calendarDeleteHandler(args: z.infer<typeof CalendarDeleteSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const result = await deleteCalendarEvent(conn, args.eventId);

    if (result.success) {
      return successResult(JSON.stringify({
        success: true,
        message: `Event ${args.eventId} deleted successfully`,
      }));
    } else {
      return errorResult(`Failed to delete event: ${result.error}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to delete calendar event: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_calendar_free_busy tool
 */
export async function calendarFreeBusyHandler(args: z.infer<typeof CalendarFreeBusySchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const result = await getFreeBusy(conn, {
      timeMin: new Date(args.timeMin),
      timeMax: new Date(args.timeMax),
    });

    return successResult(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to check free/busy: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}
