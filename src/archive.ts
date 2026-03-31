/**
 * Archive Module
 *
 * Functions for archiving and trashing email threads via MCP.
 */

import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider } from "./mcp-provider";

export interface ArchiveResult {
  success: boolean;
  error?: string;
}

export interface DeleteResult {
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
 * Archive a thread by removing it from inbox (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to archive
 * @returns Result with success status
 */
export async function archiveThread(
  provider: ConnectionProvider,
  threadId: string
): Promise<ArchiveResult> {
  const mcp = requireMcp(provider);
  try {
    await mcp.callTool("update_email", {
      thread_id: threadId,
      action: "mark_done",
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Delete (trash) a thread (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to delete
 * @returns Result with success status
 */
export async function deleteThread(
  provider: ConnectionProvider,
  threadId: string
): Promise<DeleteResult> {
  const mcp = requireMcp(provider);
  try {
    await mcp.callTool("update_email", {
      thread_id: threadId,
      action: "trash",
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
