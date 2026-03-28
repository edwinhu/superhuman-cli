/**
 * Connection Provider Module
 *
 * Abstracts token resolution so modules don't need to know
 * whether tokens come from cache or CDP.
 */

import type { SuperhumanConnection } from "./superhuman-api";
import type { TokenInfo } from "./token-api";
import {
  getCachedToken,
  getCachedAccounts,
  getToken,
  loadTokensFromDisk,
  hasValidCachedTokens,
} from "./token-api";
import { listAccounts } from "./accounts";
import { McpConnectionProvider, hasMcpTokens } from "./mcp-provider";

/**
 * Account type detection result (matches send-api.ts AccountInfo)
 */
export interface AccountInfo {
  email: string;
  isMicrosoft: boolean;
  provider: "google" | "microsoft";
}

/**
 * Abstraction for getting tokens and account info.
 * Implementations can use cached tokens or CDP connections.
 */
export interface ConnectionProvider {
  /** Get OAuth token (optionally for a specific email) */
  getToken(email?: string): Promise<TokenInfo>;
  /** Get the current account email */
  getCurrentEmail(): Promise<string>;
  /** Get account type information */
  getAccountInfo(): Promise<AccountInfo>;
  /** Clean up resources (no-op for cache, closes CDP connection) */
  disconnect(): Promise<void>;
}

/**
 * Provider that uses cached tokens from disk.
 * No CDP connection needed.
 */
export class CachedTokenProvider implements ConnectionProvider {
  constructor(private email?: string) {}

  async getToken(email?: string): Promise<TokenInfo> {
    const targetEmail = email || this.email || getCachedAccounts()[0];
    if (!targetEmail) {
      throw new Error("No cached tokens available. Run 'superhuman account auth' to authenticate.");
    }

    const token = await getCachedToken(targetEmail);
    if (!token) {
      throw new Error(
        `Token for ${targetEmail} expired or not found. Run 'superhuman account auth' to re-authenticate.`
      );
    }
    return token;
  }

  async getCurrentEmail(): Promise<string> {
    const email = this.email || getCachedAccounts()[0];
    if (!email) {
      throw new Error("No cached accounts. Run 'superhuman account auth' to authenticate.");
    }
    return email;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const token = await this.getToken();
    return {
      email: token.email,
      isMicrosoft: token.isMicrosoft,
      provider: token.isMicrosoft ? "microsoft" : "google",
    };
  }

  async disconnect(): Promise<void> {
    // No-op for cached tokens
  }
}

/**
 * Provider that uses a live CDP connection to Superhuman.
 * Used as fallback when no cached tokens exist.
 */
export class CDPConnectionProvider implements ConnectionProvider {
  constructor(private conn: SuperhumanConnection) {}

  async getToken(email?: string): Promise<TokenInfo> {
    if (email) {
      return getToken(this.conn, email);
    }
    // Get current account's token
    const accounts = await listAccounts(this.conn);
    const current = accounts.find((a) => a.isCurrent);
    if (!current) {
      throw new Error("No current account found via CDP");
    }
    return getToken(this.conn, current.email);
  }

  async getCurrentEmail(): Promise<string> {
    const accounts = await listAccounts(this.conn);
    const current = accounts.find((a) => a.isCurrent);
    if (!current) {
      throw new Error("No current account found via CDP");
    }
    return current.email;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const token = await this.getToken();
    return {
      email: token.email,
      isMicrosoft: token.isMicrosoft,
      provider: token.isMicrosoft ? "microsoft" : "google",
    };
  }

  async disconnect(): Promise<void> {
    const { disconnect } = await import("./superhuman-api");
    await disconnect(this.conn);
  }

  /** Access the underlying CDP connection (for auth/status only) */
  getConnection(): SuperhumanConnection {
    return this.conn;
  }
}

/**
 * Resolve the best available ConnectionProvider.
 *
 * Priority:
 * 1. If --account specified and token is cached -> CachedTokenProvider
 * 2. If any cached tokens exist -> CachedTokenProvider (first account)
 * 3. If MCP tokens available -> McpConnectionProvider
 * 4. If CDP available -> CDPConnectionProvider
 * 5. null (caller must handle)
 *
 * @param options - Object with optional `account` and `port` fields
 * @returns ConnectionProvider or null if no tokens and no CDP
 */
export async function resolveProvider(
  options: { account?: string; port?: number }
): Promise<ConnectionProvider | null> {
  // Try loading cached tokens
  await loadTokensFromDisk();

  // If --account specified, check if we have a cached token for it
  if (options.account) {
    const token = await getCachedToken(options.account);
    if (token) {
      return new CachedTokenProvider(options.account);
    }
    // Fall through to MCP if explicit account not in cached tokens
  }

  // If any cached tokens are valid, use the first one
  if (hasValidCachedTokens()) {
    const accounts = getCachedAccounts();
    if (accounts.length > 0) {
      return new CachedTokenProvider(accounts[0]);
    }
  }

  // Try MCP provider if no cached tokens are available
  if (await hasMcpTokens()) {
    return new McpConnectionProvider(options.account);
  }

  // No cached tokens — would need CDP, but we don't connect here
  // (caller can fall back to CDP themselves if needed)
  return null;
}

// Re-export MCP provider for direct use
export { McpConnectionProvider } from "./mcp-provider";
