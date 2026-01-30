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
  draftHandler, sendHandler, searchHandler, inboxHandler, readHandler,
  accountsHandler, switchAccountHandler, replyHandler, replyAllHandler, forwardHandler,
  archiveHandler, deleteHandler
} from "./tools";

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "superhuman-cli", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "superhuman_draft",
    {
      description: "Create an email draft in Superhuman. Opens the compose window, fills in the fields, and saves as draft.",
      inputSchema: DraftSchema,
    },
    draftHandler
  );

  server.registerTool(
    "superhuman_send",
    {
      description: "Send an email via Superhuman. Opens the compose window, fills in the fields, and sends the email.",
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

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { createMcpServer };
