/**
 * MCP Connection Provider
 *
 * Routes supported operations through Superhuman's official MCP server
 * (https://mcp.mail.superhuman.com/mcp) using OAuth 2.1 + PKCE tokens.
 *
 * This eliminates CDP dependency for the 10 MCP-supported operations.
 * CDP remains as fallback for AI endpoints and other unsupported ops.
 *
 * Token storage: ~/.mcp-auth/mcp-remote-{version}/{hash}_tokens.json
 * where hash = MD5("https://mcp.mail.superhuman.com/mcp")
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ConnectionProvider, AccountInfo } from "./connection-provider";
import type { TokenInfo } from "./token-api";
import type { InboxThread, ListInboxOptions, SearchOptions } from "./inbox";
import type { ThreadMessage } from "./read";
import type { SendEmailOptions, SendResult, DraftResult } from "./send-api";

const MCP_SERVER_URL = "https://mcp.mail.superhuman.com/mcp";
const MCP_AUTH_BASE = join(process.env.HOME || "~", ".mcp-auth");
const SERVER_URL_HASH = createHash("md5").update(MCP_SERVER_URL).digest("hex");

interface McpTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
}

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Find the mcp-remote config directory (handles version changes).
 */
async function findMcpRemoteDir(): Promise<string | null> {
  try {
    const entries = await readdir(MCP_AUTH_BASE);
    const mcpDirs = entries
      .filter((e) => e.startsWith("mcp-remote-"))
      .sort()
      .reverse();
    if (mcpDirs.length === 0) return null;
    return join(MCP_AUTH_BASE, mcpDirs[0]);
  } catch {
    return null;
  }
}

/**
 * Load MCP OAuth tokens from mcp-remote's storage.
 */
export async function loadMcpTokens(): Promise<McpTokens | null> {
  const dir = await findMcpRemoteDir();
  if (!dir) return null;

  try {
    const tokenFile = join(dir, `${SERVER_URL_HASH}_tokens.json`);
    const content = await readFile(tokenFile, "utf-8");
    return JSON.parse(content) as McpTokens;
  } catch {
    return null;
  }
}

/**
 * Call a tool on the Superhuman MCP server via HTTP Streamable transport.
 */
async function callMcpTool(
  accessToken: string,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<McpToolResult> {
  const response = await fetch(MCP_SERVER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MCP call failed (${response.status}): ${text}`);
  }

  const result = await response.json();
  if (result.error) {
    throw new Error(`MCP error: ${result.error.message}`);
  }

  return result.result as McpToolResult;
}

// Actual MCP tool names from Superhuman's server
export const MCP_SUPPORTED_TOOLS = [
  "query_email_and_calendar",
  "list_email",
  "get_email_thread",
  "get_read_statuses",
  "draft_email",
  "send_email",
  "update_email",
  "create_or_update_event",
  "get_availability_calendar",
  "update_preferences_email_and_calendar",
] as const;

export type McpToolName = (typeof MCP_SUPPORTED_TOOLS)[number];

/**
 * Check if MCP tokens are available and valid.
 */
export async function hasMcpTokens(): Promise<boolean> {
  const tokens = await loadMcpTokens();
  return tokens !== null && !!tokens.access_token;
}

// ============================================================================
// MCP Response Parsing
// ============================================================================

/**
 * Extract the text content from an MCP tool result.
 */
export function getMcpText(result: McpToolResult): string {
  return result.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n") || "";
}

/**
 * Try to parse MCP text as JSON. MCP server may return structured JSON
 * or formatted text depending on the tool.
 */
function tryParseJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse MCP list_email response into InboxThread[].
 *
 * The MCP server returns formatted text. We parse it into our internal format.
 * If the response contains JSON, we use that directly.
 */
export function parseMcpInboxThreads(result: McpToolResult): InboxThread[] {
  const text = getMcpText(result);
  if (!text) return [];

  // Try JSON first
  const json = tryParseJson(text);
  if (json) {
    if (Array.isArray(json)) {
      return json.map(normalizeInboxThread);
    }
    if (json.emails && Array.isArray(json.emails)) {
      return json.emails.map(normalizeInboxThread);
    }
    if (json.threads && Array.isArray(json.threads)) {
      return json.threads.map(normalizeInboxThread);
    }
  }

  // Parse structured text response
  return parseTextInboxThreads(text);
}

/**
 * Normalize a JSON email object from MCP into our InboxThread format.
 */
function normalizeInboxThread(item: any): InboxThread {
  return {
    id: item.id || item.thread_id || item.threadId || "",
    subject: item.subject || "(no subject)",
    from: {
      email: item.from?.email || item.from_email || item.from || "",
      name: item.from?.name || item.from_name || "",
    },
    date: item.date || item.received_at || item.receivedDateTime || "",
    snippet: item.snippet || item.preview || item.body_preview || "",
    labelIds: item.labels || item.labelIds || [],
    messageCount: item.message_count || item.messageCount || 1,
  };
}

/**
 * Parse structured text email listings into InboxThread[].
 * Handles common MCP text formats like:
 *   Subject: ...
 *   From: ...
 *   Date: ...
 */
function parseTextInboxThreads(text: string): InboxThread[] {
  const threads: InboxThread[] = [];

  // Split on double newlines or numbered entries
  const blocks = text.split(/\n\n+|\n(?=\d+\.\s)/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const subject = extractField(trimmed, "Subject") || extractField(trimmed, "Title") || trimmed.split("\n")[0]?.replace(/^\d+\.\s*/, "").trim() || "";
    const from = extractField(trimmed, "From") || "";
    const date = extractField(trimmed, "Date") || extractField(trimmed, "Received") || "";
    const snippet = extractField(trimmed, "Preview") || extractField(trimmed, "Snippet") || "";
    const id = extractField(trimmed, "ID") || extractField(trimmed, "Thread") || "";

    if (subject || from) {
      const fromParsed = parseFromField(from);
      threads.push({
        id,
        subject: subject || "(no subject)",
        from: fromParsed,
        date,
        snippet,
        labelIds: [],
        messageCount: 1,
      });
    }
  }

  return threads;
}

/**
 * Parse MCP get_email_thread response into ThreadMessage[].
 */
export function parseMcpThread(result: McpToolResult): ThreadMessage[] {
  const text = getMcpText(result);
  if (!text) return [];

  const json = tryParseJson(text);
  if (json) {
    const messages = Array.isArray(json) ? json : (json.messages || json.emails || [json]);
    return messages.map(normalizeThreadMessage);
  }

  // Parse text format
  return parseTextThreadMessages(text);
}

function normalizeThreadMessage(item: any): ThreadMessage {
  return {
    id: item.id || item.message_id || "",
    threadId: item.thread_id || item.threadId || "",
    subject: item.subject || "(no subject)",
    from: {
      email: item.from?.email || item.from_email || item.from || "",
      name: item.from?.name || item.from_name || "",
    },
    to: normalizeRecipientList(item.to || item.to_recipients || []),
    cc: normalizeRecipientList(item.cc || item.cc_recipients || []),
    date: item.date || item.received_at || "",
    snippet: item.snippet || item.body_preview || item.body || "",
  };
}

function normalizeRecipientList(
  list: any
): Array<{ email: string; name: string }> {
  if (!list) return [];
  if (typeof list === "string") {
    return list
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map((s: string) => parseFromField(s));
  }
  if (Array.isArray(list)) {
    return list.map((r: any) => {
      if (typeof r === "string") return parseFromField(r);
      return { email: r.email || r.address || "", name: r.name || "" };
    });
  }
  return [];
}

function parseTextThreadMessages(text: string): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  const blocks = text.split(/\n\n+|\n(?=---)/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const from = extractField(trimmed, "From") || "";
    const subject = extractField(trimmed, "Subject") || "";
    const date = extractField(trimmed, "Date") || "";
    const to = extractField(trimmed, "To") || "";
    const cc = extractField(trimmed, "Cc") || extractField(trimmed, "CC") || "";

    if (from || subject) {
      messages.push({
        id: extractField(trimmed, "ID") || "",
        threadId: extractField(trimmed, "Thread") || "",
        subject: subject || "(no subject)",
        from: parseFromField(from),
        to: to ? to.split(",").map((s) => parseFromField(s.trim())) : [],
        cc: cc ? cc.split(",").map((s) => parseFromField(s.trim())) : [],
        date,
        snippet: extractField(trimmed, "Body") || extractField(trimmed, "Preview") || "",
      });
    }
  }

  return messages;
}

// ============================================================================
// Utility helpers
// ============================================================================

function extractField(text: string, field: string): string {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "mi");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function parseFromField(from: string): { email: string; name: string } {
  if (!from) return { email: "", name: "" };
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim().replace(/^["']|["']$/g, ""), email: match[2] };
  }
  return { email: from.trim(), name: "" };
}

// ============================================================================
// McpConnectionProvider
// ============================================================================

/**
 * Connection provider that routes operations through the Superhuman MCP server.
 *
 * For MCP-supported operations, use the typed methods (listInbox, readThread,
 * sendEmail, etc.) which call the MCP server and parse responses into our
 * internal types.
 *
 * The getToken() method returns a synthetic TokenInfo that should NOT be used
 * with Gmail/MS Graph APIs directly — it contains a WorkOS token.
 */
export class McpConnectionProvider implements ConnectionProvider {
  private tokens: McpTokens | null = null;
  private email: string | undefined;

  constructor(email?: string) {
    this.email = email;
  }

  private async ensureTokens(): Promise<McpTokens> {
    if (!this.tokens) {
      this.tokens = await loadMcpTokens();
    }
    if (!this.tokens) {
      throw new Error(
        "No MCP tokens found. Run 'npx @superhuman/mcp-mail' to authenticate."
      );
    }
    return this.tokens;
  }

  /**
   * Call an MCP tool with automatic token handling.
   */
  async callTool(
    toolName: McpToolName,
    args: Record<string, unknown> = {}
  ): Promise<McpToolResult> {
    const tokens = await this.ensureTokens();
    return callMcpTool(tokens.access_token, toolName, args);
  }

  // ========================================================================
  // High-level operations (used by command modules)
  // ========================================================================

  /**
   * List inbox threads via MCP list_email tool.
   */
  async listInbox(options: ListInboxOptions = {}): Promise<InboxThread[]> {
    const args: Record<string, unknown> = {};

    // Build filter criteria for list_email
    if (options.limit) args.limit = options.limit;
    if (options.unreadOnly) args.is_unread = true;
    if (options.focusedOnly) args.split = "important";
    if (options.splitInbox) args.split = options.splitInbox;
    if (options.aiLabel) args.ai_label = options.aiLabel;

    const result = await this.callTool("list_email", args);
    let threads = parseMcpInboxThreads(result);

    // Apply client-side filters that MCP may not support
    if (options.needsReply && this.email) {
      const userEmail = this.email.toLowerCase();
      threads = threads.filter((t) =>
        t.messageCount <= 1 || t.from.email.toLowerCase() !== userEmail
      );
    }

    return threads.slice(0, options.limit ?? 10);
  }

  /**
   * Search emails via MCP query_email_and_calendar tool.
   */
  async searchInbox(query: string, limit: number = 10): Promise<InboxThread[]> {
    const result = await this.callTool("query_email_and_calendar", {
      question: query,
    });
    return parseMcpInboxThreads(result).slice(0, limit);
  }

  /**
   * Read a thread via MCP get_email_thread tool.
   */
  async readThread(threadId: string): Promise<ThreadMessage[]> {
    const result = await this.callTool("get_email_thread", {
      thread_id: threadId,
    });
    return parseMcpThread(result);
  }

  /**
   * Send an email via MCP send_email tool.
   */
  async sendEmail(options: SendEmailOptions): Promise<SendResult> {
    try {
      // MCP send_email expects to/cc/bcc as [{email, name}] objects
      const toRecipients = (emails: string[]) =>
        emails.map((e) => ({ email: e }));

      const args: Record<string, unknown> = {
        to: toRecipients(options.to),
        subject: options.subject,
        body: options.body || "",
      };
      if (options.cc?.length) args.cc = toRecipients(options.cc);
      if (options.bcc?.length) args.bcc = toRecipients(options.bcc);
      if (options.inReplyTo) args.in_reply_to = options.inReplyTo;
      if (options.threadId) args.thread_id = options.threadId;

      const result = await this.callTool("send_email", args);
      const text = getMcpText(result);
      const json = tryParseJson(text);

      return {
        success: !result.isError,
        messageId: json?.message_id || json?.id,
        threadId: json?.thread_id,
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Create or update a draft via MCP draft_email tool.
   *
   * Note: draft_email is AI-powered and takes `instructions` rather than
   * a literal body. We pass the body as instructions for the AI to compose.
   */
  async createDraft(options: SendEmailOptions): Promise<DraftResult> {
    try {
      const args: Record<string, unknown> = {
        instructions: options.body || options.subject || "Draft email",
      };
      if (options.to?.length) args.to = options.to;
      if (options.subject) args.subject = options.subject;
      if (options.threadId) args.thread_id = options.threadId;

      const result = await this.callTool("draft_email", args);
      const text = getMcpText(result);
      const json = tryParseJson(text);

      return {
        success: !result.isError,
        draftId: json?.draft_id || json?.id,
        messageId: json?.message_id,
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Reply to a thread via MCP send_email with in_reply_to context.
   */
  async replyToThread(
    threadId: string,
    body: string,
    options: { replyAll?: boolean; send?: boolean } = {}
  ): Promise<{ success: boolean; messageId?: string; draftId?: string; error?: string }> {
    // First, get thread info to construct the reply
    const messages = await this.readThread(threadId);
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage) {
      return { success: false, error: "Could not read thread for reply" };
    }

    const replyTo = options.replyAll
      ? [...lastMessage.to.map((r) => r.email), lastMessage.from.email]
      : [lastMessage.from.email];

    // Filter out our own email
    const filteredTo = this.email
      ? replyTo.filter((e) => e.toLowerCase() !== this.email!.toLowerCase())
      : replyTo;

    const subject = lastMessage.subject.startsWith("Re:")
      ? lastMessage.subject
      : `Re: ${lastMessage.subject}`;

    if (options.send) {
      return this.sendEmail({
        to: filteredTo,
        subject,
        body,
        isHtml: true,
        threadId,
        inReplyTo: lastMessage.id,
      });
    }

    return this.createDraft({
      to: filteredTo,
      subject,
      body,
      threadId,
      inReplyTo: lastMessage.id,
    });
  }

  /**
   * Send an existing draft by ID.
   *
   * MCP send_email requires full content (to, subject, body) — not supported
   * for sending by draft ID alone. Callers should use the draft_id/draft_thread_id
   * fields if the draft was created via MCP draft_email.
   */
  async sendDraftById(
    draftId: string,
    draftThreadId?: string
  ): Promise<SendResult> {
    // MCP send_email can reference a draft via draft_id + draft_thread_id
    // but still requires to, subject, body as required fields.
    // Without knowing the draft content, we cannot send via MCP alone.
    return {
      success: false,
      error: "Sending drafts by ID is not supported via MCP. Use the Gmail/Microsoft API path instead.",
    };
  }

  // ========================================================================
  // ConnectionProvider interface
  // ========================================================================

  async getToken(_email?: string): Promise<TokenInfo> {
    const tokens = await this.ensureTokens();
    // WARNING: This is a WorkOS token, NOT a Gmail/MS Graph token.
    // Do not use this with direct Gmail/MS Graph API calls.
    return {
      accessToken: tokens.access_token,
      email: this.email || "",
      expires: Date.now() + (tokens.expires_in || 3600) * 1000,
      isMicrosoft: false,
    };
  }

  async getCurrentEmail(): Promise<string> {
    if (this.email) return this.email;
    throw new Error(
      "Cannot determine account email via MCP. Provide --account flag."
    );
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const email = await this.getCurrentEmail();
    return {
      email,
      isMicrosoft: false,
      provider: "google",
    };
  }

  async disconnect(): Promise<void> {
    this.tokens = null;
  }
}

/**
 * Check if a given operation can be handled by the MCP provider.
 */
export function isMcpSupported(operation: string): boolean {
  return (MCP_SUPPORTED_TOOLS as readonly string[]).includes(operation);
}
