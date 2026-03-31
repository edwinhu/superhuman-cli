/**
 * Read Module
 *
 * Functions for reading thread/message content via MCP provider.
 */

import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider } from "./mcp-provider";

export interface ThreadMessage {
  id: string;
  threadId: string;
  subject: string;
  from: {
    email: string;
    name: string;
  };
  to: Array<{ email: string; name: string }>;
  cc: Array<{ email: string; name: string }>;
  date: string;
  snippet: string;
  body?: string;
}

/**
 * Read all messages in a thread via MCP provider.
 */
export async function readThread(
  provider: ConnectionProvider,
  threadId: string
): Promise<ThreadMessage[]> {
  // Route through MCP if available
  if (provider instanceof McpConnectionProvider) {
    return provider.readThread(threadId);
  }

  throw new Error(
    "readThread requires an MCP provider. Direct API path has been removed. " +
    "Run 'superhuman account auth' to set up MCP credentials."
  );
}
