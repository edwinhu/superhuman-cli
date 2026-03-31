/**
 * Labels Module
 *
 * Functions for managing email labels/folders via MCP.
 */

import type { ConnectionProvider } from "./connection-provider";
import { requireMcp } from "./mcp-guard";

export interface Label {
  id: string;
  name: string;
  type?: string;
}

export interface LabelResult {
  success: boolean;
  error?: string;
}

/**
 * List all available labels/folders in the account
 *
 * @param provider - The connection provider
 * @returns Array of labels with id and name
 */
export async function listLabels(_provider: ConnectionProvider): Promise<Label[]> {
  // TODO: Implement via MCP when a list_labels tool is available
  throw new Error("MCP connection required. Run 'superhuman account auth' to set up MCP.");
}

/**
 * Get labels for a specific thread
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to get labels for
 * @returns Array of labels on the thread
 */
export async function getThreadLabels(
  _provider: ConnectionProvider,
  _threadId: string
): Promise<Label[]> {
  // TODO: Implement via MCP when a get_thread_labels tool is available
  throw new Error("MCP connection required. Run 'superhuman account auth' to set up MCP.");
}

/**
 * Add a label to a thread (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to add the label to
 * @param labelId - The label ID to add
 * @returns Result with success status
 */
export async function addLabel(
  provider: ConnectionProvider,
  threadId: string,
  labelId: string
): Promise<LabelResult> {
  const mcp = requireMcp(provider);
  try {
    await mcp.callTool("update_email", {
      thread_id: threadId,
      action: "add_label",
      label: labelId,
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Remove a label from a thread (server-persisted)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to remove the label from
 * @param labelId - The label ID to remove
 * @returns Result with success status
 */
export async function removeLabel(
  provider: ConnectionProvider,
  threadId: string,
  labelId: string
): Promise<LabelResult> {
  const mcp = requireMcp(provider);
  try {
    await mcp.callTool("update_email", {
      thread_id: threadId,
      action: "remove_label",
      label: labelId,
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Star a thread (adds STARRED label)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to star
 * @returns Result with success status
 */
export async function starThread(
  provider: ConnectionProvider,
  threadId: string
): Promise<LabelResult> {
  const mcp = requireMcp(provider);
  try {
    await mcp.callTool("update_email", {
      thread_id: threadId,
      action: "star",
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Unstar a thread (removes STARRED label)
 *
 * @param provider - The connection provider
 * @param threadId - The thread ID to unstar
 * @returns Result with success status
 */
export async function unstarThread(
  provider: ConnectionProvider,
  threadId: string
): Promise<LabelResult> {
  const mcp = requireMcp(provider);
  try {
    await mcp.callTool("update_email", {
      thread_id: threadId,
      action: "unstar",
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * List all starred threads
 *
 * @param provider - The connection provider
 * @param limit - Maximum number of threads to return (default: 50)
 * @returns Array of starred threads with their IDs
 */
export async function listStarred(
  _provider: ConnectionProvider,
  _limit: number = 50
): Promise<Array<{ id: string }>> {
  // TODO: Implement via MCP when a search/filter tool supports starred filter
  throw new Error("MCP connection required. Run 'superhuman account auth' to set up MCP.");
}
