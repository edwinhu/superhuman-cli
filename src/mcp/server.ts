/**
 * MCP Server for Superhuman CLI
 *
 * Exposes Superhuman automation functions as MCP tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DraftSchema, SendSchema, SearchSchema, InboxSchema, ReadSchema,
  AccountsSchema, SwitchAccountSchema, ReplySchema, ReplyAllSchema, ForwardSchema,
  ArchiveSchema, DeleteSchema,
  MarkReadSchema, MarkUnreadSchema, LabelsSchema, GetLabelsSchema, AddLabelSchema, RemoveLabelSchema,
  StarSchema, UnstarSchema, StarredSchema,
  SnoozeSchema, UnsnoozeSchema, SnoozedSchema,
  AttachmentsSchema, DownloadAttachmentSchema,
  CalendarListSchema, CalendarCreateSchema, CalendarUpdateSchema, CalendarDeleteSchema, CalendarFreeBusySchema,
  draftHandler, sendHandler, searchHandler, inboxHandler, readHandler,
  accountsHandler, switchAccountHandler, replyHandler, replyAllHandler, forwardHandler,
  archiveHandler, deleteHandler,
  markReadHandler, markUnreadHandler, labelsHandler, getLabelsHandler, addLabelHandler, removeLabelHandler,
  starHandler, unstarHandler, starredHandler,
  snoozeHandler, unsnoozeHandler, snoozedHandler,
  attachmentsHandler, downloadAttachmentHandler,
  calendarListHandler, calendarCreateHandler, calendarUpdateHandler, calendarDeleteHandler, calendarFreeBusyHandler,
  SnippetsSchema, UseSnippetSchema,
  snippetsHandler, useSnippetHandler,
  AskAISchema, askAIHandler,
} from "./tools";

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "superhuman-cli", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "superhuman_draft",
    {
      description: "Create an email draft via Gmail/Outlook API using cached OAuth tokens.",
      inputSchema: DraftSchema,
    },
    draftHandler
  );

  server.registerTool(
    "superhuman_send",
    {
      description: "Send an email via Gmail/Outlook API using cached OAuth tokens.",
      inputSchema: SendSchema,
    },
    sendHandler
  );

  server.registerTool(
    "superhuman_search",
    {
      description: "Search the Superhuman inbox. Returns a list of emails matching the search query.",
      inputSchema: SearchSchema,
    },
    searchHandler
  );

  server.registerTool(
    "superhuman_inbox",
    {
      description: "List recent emails from the Superhuman inbox. Returns thread summaries with from, subject, date, and snippet.",
      inputSchema: InboxSchema,
    },
    inboxHandler
  );

  server.registerTool(
    "superhuman_read",
    {
      description: "Read a specific email thread by ID. Returns all messages in the thread with full details.",
      inputSchema: ReadSchema,
    },
    readHandler
  );

  server.registerTool(
    "superhuman_accounts",
    {
      description: "List all linked email accounts in Superhuman. Returns accounts with current marker.",
      inputSchema: AccountsSchema,
    },
    accountsHandler
  );

  server.registerTool(
    "superhuman_switch_account",
    {
      description: "Switch to a different linked email account in Superhuman. Accepts either an email address or a 1-based index number.",
      inputSchema: SwitchAccountSchema,
    },
    switchAccountHandler
  );

  server.registerTool(
    "superhuman_reply",
    {
      description: "Reply to an email thread. Creates a draft by default, or sends immediately with send=true. The reply is addressed to the sender of the last message in the thread.",
      inputSchema: ReplySchema,
    },
    replyHandler
  );

  server.registerTool(
    "superhuman_reply_all",
    {
      description: "Reply-all to an email thread. Creates a draft by default, or sends immediately with send=true. The reply is addressed to all recipients of the last message (excluding yourself).",
      inputSchema: ReplyAllSchema,
    },
    replyAllHandler
  );

  server.registerTool(
    "superhuman_forward",
    {
      description: "Forward an email thread to a new recipient. Creates a draft by default, or sends immediately with send=true. Includes the original message with forwarding headers.",
      inputSchema: ForwardSchema,
    },
    forwardHandler
  );

  server.registerTool(
    "superhuman_archive",
    {
      description: "Archive one or more email threads. Removes threads from inbox without deleting them.",
      inputSchema: ArchiveSchema,
    },
    archiveHandler
  );

  server.registerTool(
    "superhuman_delete",
    {
      description: "Delete (trash) one or more email threads. Moves threads to the trash folder.",
      inputSchema: DeleteSchema,
    },
    deleteHandler
  );

  server.registerTool(
    "superhuman_mark_read",
    {
      description: "Mark one or more email threads as read. Removes the unread indicator from threads.",
      inputSchema: MarkReadSchema,
    },
    markReadHandler
  );

  server.registerTool(
    "superhuman_mark_unread",
    {
      description: "Mark one or more email threads as unread. Adds the unread indicator to threads.",
      inputSchema: MarkUnreadSchema,
    },
    markUnreadHandler
  );

  server.registerTool(
    "superhuman_labels",
    {
      description: "List all available labels/folders in the Superhuman account. Returns label IDs and names.",
      inputSchema: LabelsSchema,
    },
    labelsHandler
  );

  server.registerTool(
    "superhuman_get_labels",
    {
      description: "Get all labels on a specific email thread. Returns label IDs and names for the thread.",
      inputSchema: GetLabelsSchema,
    },
    getLabelsHandler
  );

  server.registerTool(
    "superhuman_add_label",
    {
      description: "Add a label to one or more email threads. Use superhuman_labels first to get available label IDs.",
      inputSchema: AddLabelSchema,
    },
    addLabelHandler
  );

  server.registerTool(
    "superhuman_remove_label",
    {
      description: "Remove a label from one or more email threads. Use superhuman_get_labels to see current labels on a thread.",
      inputSchema: RemoveLabelSchema,
    },
    removeLabelHandler
  );

  server.registerTool(
    "superhuman_star",
    {
      description: "Star one or more email threads. Adds the STARRED label to mark threads as important.",
      inputSchema: StarSchema,
    },
    starHandler
  );

  server.registerTool(
    "superhuman_unstar",
    {
      description: "Unstar one or more email threads. Removes the STARRED label from threads.",
      inputSchema: UnstarSchema,
    },
    unstarHandler
  );

  server.registerTool(
    "superhuman_starred",
    {
      description: "List all starred email threads. Returns thread IDs of emails marked with the STARRED label.",
      inputSchema: StarredSchema,
    },
    starredHandler
  );

  server.registerTool(
    "superhuman_snooze",
    {
      description: "Snooze one or more email threads until a specific time. Use presets (tomorrow, next-week, weekend, evening) or ISO datetime.",
      inputSchema: SnoozeSchema,
    },
    snoozeHandler
  );

  server.registerTool(
    "superhuman_unsnooze",
    {
      description: "Unsnooze one or more email threads. Cancels the snooze and returns threads to inbox.",
      inputSchema: UnsnoozeSchema,
    },
    unsnoozeHandler
  );

  server.registerTool(
    "superhuman_snoozed",
    {
      description: "List all snoozed email threads. Returns thread IDs and snooze times.",
      inputSchema: SnoozedSchema,
    },
    snoozedHandler
  );

  server.registerTool(
    "superhuman_attachments",
    {
      description: "List all attachments in an email thread. Returns attachment names, MIME types, and IDs needed for downloading.",
      inputSchema: AttachmentsSchema,
    },
    attachmentsHandler
  );

  server.registerTool(
    "superhuman_download_attachment",
    {
      description: "Download an attachment from an email. Returns the file content as base64-encoded data along with size and MIME type. Use superhuman_attachments first to get the messageId and attachmentId.",
      inputSchema: DownloadAttachmentSchema,
    },
    downloadAttachmentHandler
  );

  server.registerTool(
    "superhuman_calendar_list",
    {
      description: "List calendar events from Superhuman. Returns events for a date range with details including title, time, attendees, and event ID.",
      inputSchema: CalendarListSchema,
    },
    calendarListHandler
  );

  server.registerTool(
    "superhuman_calendar_create",
    {
      description: "Create a new calendar event in Superhuman. Supports timed events and all-day events with optional attendees.",
      inputSchema: CalendarCreateSchema,
    },
    calendarCreateHandler
  );

  server.registerTool(
    "superhuman_calendar_update",
    {
      description: "Update an existing calendar event in Superhuman. Can modify title, times, description, or attendees.",
      inputSchema: CalendarUpdateSchema,
    },
    calendarUpdateHandler
  );

  server.registerTool(
    "superhuman_calendar_delete",
    {
      description: "Delete a calendar event from Superhuman by its event ID.",
      inputSchema: CalendarDeleteSchema,
    },
    calendarDeleteHandler
  );

  server.registerTool(
    "superhuman_calendar_free_busy",
    {
      description: "Check free/busy availability in the calendar. Returns busy time slots within the specified time range.",
      inputSchema: CalendarFreeBusySchema,
    },
    calendarFreeBusyHandler
  );

  server.registerTool(
    "superhuman_snippets",
    {
      description: "List all snippets (reusable email templates) in Superhuman. Returns snippet names, usage stats, and previews.",
      inputSchema: SnippetsSchema,
    },
    snippetsHandler
  );

  server.registerTool(
    "superhuman_snippet",
    {
      description: "Use a snippet to compose or send an email. Fuzzy-matches snippet by name, applies template variables, and creates a draft or sends immediately.",
      inputSchema: UseSnippetSchema,
    },
    useSnippetHandler
  );

  server.registerTool(
    "superhuman_ask_ai",
    {
      description: "Ask Superhuman AI to search emails, answer questions, or compose drafts. Supports natural language queries like 'find emails about the project deadline' or 'what did John say about the budget?'. Optionally provide a thread ID to ask about a specific email thread.",
      inputSchema: AskAISchema,
    },
    askAIHandler
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { createMcpServer };
