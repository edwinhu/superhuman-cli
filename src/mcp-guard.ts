import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider } from "./mcp-provider";

/**
 * Require that the provider is an MCP connection.
 * Throws if provider is not MCP — all operations now require MCP auth.
 */
export function requireMcp(provider: ConnectionProvider): McpConnectionProvider {
  if (provider instanceof McpConnectionProvider) {
    return provider;
  }
  throw new Error("MCP connection required. Run 'superhuman account auth' to set up MCP.");
}
