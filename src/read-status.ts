/**
 * Read Status Module
 *
 * Functions for marking email threads as read or unread via MCP.
 */

import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider } from "./mcp-provider";

export interface ReadStatusResult {
  success: boolean;
  error?: string;
}

function requireMcp(provider: ConnectionProvider): McpConnectionProvider {
  if (provider instanceof McpConnectionProvider) {
    return provider;
  }
  throw new Error("MCP connection required. Run 'superhuman account auth' to set up MCP.");
}

/**
 * Mark a thread as read (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to mark as read
 * @returns Result with success status
 */
export async function markAsRead(
  provider: ConnectionProvider,
  threadId: string
): Promise<ReadStatusResult> {
  const mcp = requireMcp(provider);
  try {
    await mcp.callTool("update_email", {
      thread_id: threadId,
      action: "mark_read",
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Mark a thread as unread (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to mark as unread
 * @returns Result with success status
 */
export async function markAsUnread(
  provider: ConnectionProvider,
  threadId: string
): Promise<ReadStatusResult> {
  const mcp = requireMcp(provider);
  try {
    await mcp.callTool("update_email", {
      thread_id: threadId,
      action: "mark_unread",
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
