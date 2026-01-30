/**
 * MCP Server for Superhuman CLI
 *
 * Exposes Superhuman automation functions as MCP tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DraftSchema, SendSchema, SearchSchema, InboxSchema, ReadSchema,
  AccountsSchema, SwitchAccountSchema,
  draftHandler, sendHandler, searchHandler, inboxHandler, readHandler,
  accountsHandler, switchAccountHandler
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

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { createMcpServer };
