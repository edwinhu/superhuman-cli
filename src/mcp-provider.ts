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

const MCP_SERVER_URL = "https://mcp.mail.superhuman.com/mcp";
const MCP_AUTH_BASE = join(process.env.HOME || "~", ".mcp-auth");
const SERVER_URL_HASH = createHash("md5").update(MCP_SERVER_URL).digest("hex");

interface McpTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
}

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Find the mcp-remote config directory (handles version changes).
 */
async function findMcpRemoteDir(): Promise<string | null> {
  try {
    const entries = await readdir(MCP_AUTH_BASE);
    // Find the most recent mcp-remote directory
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
 * Load MCP client info for token refresh.
 */
async function loadMcpClientInfo(): Promise<{ client_id: string } | null> {
  const dir = await findMcpRemoteDir();
  if (!dir) return null;

  try {
    const clientFile = join(dir, `${SERVER_URL_HASH}_client_info.json`);
    const content = await readFile(clientFile, "utf-8");
    return JSON.parse(content);
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

/**
 * List available tools on the MCP server.
 */
async function listMcpTools(
  accessToken: string
): Promise<Array<{ name: string; description: string }>> {
  const response = await fetch(MCP_SERVER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP tools/list failed: ${response.status}`);
  }

  const result = await response.json();
  return result.result?.tools || [];
}

// MCP tool names that map to our operations
export const MCP_SUPPORTED_TOOLS = [
  "list_emails",
  "get_email",
  "search_emails",
  "send_email",
  "create_draft",
  "get_draft",
  "list_calendar_events",
  "get_calendar_event",
  "create_calendar_event",
  "delete_calendar_event",
] as const;

export type McpToolName = (typeof MCP_SUPPORTED_TOOLS)[number];

/**
 * Check if MCP tokens are available and valid.
 */
export async function hasMcpTokens(): Promise<boolean> {
  const tokens = await loadMcpTokens();
  return tokens !== null && !!tokens.access_token;
}

/**
 * Connection provider that routes operations through the Superhuman MCP server.
 *
 * Provides a higher-level API than raw MCP calls, matching the ConnectionProvider
 * interface so it can be used as a drop-in replacement.
 *
 * Note: This provider can only execute MCP-supported operations. For AI endpoints
 * and other operations not exposed via MCP, callers should fall back to CDP.
 */
export class McpConnectionProvider implements ConnectionProvider {
  private tokens: McpTokens | null = null;
  private email: string | undefined;

  constructor(email?: string) {
    this.email = email;
  }

  /**
   * Ensure we have valid MCP tokens loaded.
   */
  private async ensureTokens(): Promise<McpTokens> {
    if (!this.tokens) {
      this.tokens = await loadMcpTokens();
    }
    if (!this.tokens) {
      throw new Error(
        "No MCP tokens found. Run 'npx @superhuman/mcp-mail' to authenticate with the Superhuman MCP server."
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

  /**
   * List available MCP tools (useful for discovery/debugging).
   */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const tokens = await this.ensureTokens();
    return listMcpTools(tokens.access_token);
  }

  // ConnectionProvider interface implementation

  async getToken(_email?: string): Promise<TokenInfo> {
    const tokens = await this.ensureTokens();
    // Construct a synthetic TokenInfo from MCP tokens.
    // MCP tokens are WorkOS-issued and can't be used for /~backend/ calls,
    // but they work for MCP-proxied operations.
    return {
      accessToken: tokens.access_token,
      email: this.email || "",
      expires: Date.now() + (tokens.expires_in || 3600) * 1000,
      isMicrosoft: false, // MCP abstracts away the provider
    };
  }

  async getCurrentEmail(): Promise<string> {
    if (this.email) return this.email;
    // Try to get email from a lightweight MCP call
    try {
      const result = await this.callTool("list_emails", { limit: 1 });
      // Parse email from result if available
      const text = result.content?.[0]?.text || "";
      // The MCP server response may contain account info
      return this.email || "unknown";
    } catch {
      throw new Error(
        "Cannot determine account email. Provide --account flag or authenticate via 'npx @superhuman/mcp-mail'."
      );
    }
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const email = await this.getCurrentEmail();
    return {
      email,
      isMicrosoft: false, // MCP abstracts provider type
      provider: "google",
    };
  }

  async disconnect(): Promise<void> {
    // No persistent connection to clean up
    this.tokens = null;
  }
}

/**
 * Check if a given operation can be handled by the MCP provider.
 */
export function isMcpSupported(operation: string): boolean {
  return (MCP_SUPPORTED_TOOLS as readonly string[]).includes(operation);
}
