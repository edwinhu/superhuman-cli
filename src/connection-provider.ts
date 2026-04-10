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
} from "./token-api";
import { listAccounts } from "./accounts";
import { SuperhumanProvider, type SuperhumanTokenInfo } from "./superhuman-provider";

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
 * Build the best provider from a cached TokenInfo.
 * If the token has a superhumanToken, return SuperhumanProvider;
 * otherwise fall back to CachedTokenProvider for backward compat.
 */
function providerFromToken(token: TokenInfo, email: string): ConnectionProvider {
  if (token.superhumanToken) {
    const shTokenInfo: SuperhumanTokenInfo = {
      token: token.superhumanToken.token,
      email: token.email,
      expires: token.superhumanToken.expires,
      userPrefix: token.userPrefix,
    };
    return new SuperhumanProvider(shTokenInfo);
  }
  return new CachedTokenProvider(email);
}

/**
 * Resolve the best available ConnectionProvider.
 *
 * Priority:
 * 1. If --account specified and token is cached (or refreshable via CDP) -> SuperhumanProvider or CachedTokenProvider
 * 2. If any cached accounts exist -> try getCachedToken() which auto-refreshes via CDP if expired
 * 3. null if no cached accounts at all (caller must handle)
 *
 * @param options - Object with optional `account` and `port` fields
 * @returns ConnectionProvider or null if no tokens and no CDP
 */
export async function resolveProvider(
  options: { account?: string; port?: number }
): Promise<ConnectionProvider | null> {
  // Try loading cached tokens
  await loadTokensFromDisk();

  // If --account specified, only use that account — do not fall through to others.
  // If the account isn't cached, return null immediately so callers can show
  // a targeted "no credentials for <email>" error rather than silently using
  // a different account or hanging on CDP refresh.
  if (options.account) {
    const token = await getCachedToken(options.account);
    if (token) {
      return providerFromToken(token, options.account);
    }
    return null;
  }

  // Try cached accounts — getCachedToken() will attempt CDP refresh if expired
  const accounts = getCachedAccounts();
  if (accounts.length > 0) {
    const token = await getCachedToken(accounts[0]);
    if (token) {
      return providerFromToken(token, accounts[0]);
    }
    // Token expired and CDP refresh failed — return CachedTokenProvider so
    // caller gets a meaningful error rather than falling through to CDP auth
    return new CachedTokenProvider(accounts[0]);
  }

  // No cached accounts at all — caller must handle
  return null;
}
