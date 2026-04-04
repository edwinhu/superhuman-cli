/**
 * Superhuman Provider
 *
 * A ConnectionProvider backed by a Superhuman backend JWT token.
 * Optionally wraps a CDP connection for portal RPC operations.
 */

import type { ConnectionProvider, AccountInfo } from "./connection-provider";
import type { TokenInfo } from "./token-api";
import type { SuperhumanConnection } from "./superhuman-api";
import { portalInvoke as _portalInvoke } from "./portal-rpc";
import { refreshTokenViaCDP } from "./token-api";

const SUPERHUMAN_BACKEND_BASE = "https://mail.superhuman.com/~backend";
const _AUTH_FAILED = Symbol("auth_failed");

/**
 * Token info for direct Superhuman backend access.
 * Much simpler than the full TokenInfo which carries OAuth fields.
 */
export interface SuperhumanTokenInfo {
  /** Superhuman backend JWT */
  token: string;
  /** Account email */
  email: string;
  /** Superhuman account ID */
  accountId?: string;
  /** Token expiry as ms timestamp */
  expires?: number;
  /** 4-char user prefix for event ID generation (e.g., "4sKP") */
  userPrefix?: string;
}

/**
 * ConnectionProvider that uses Superhuman's own JWT for API calls.
 * Optionally holds a CDP connection for portal RPC operations.
 */
export class SuperhumanProvider implements ConnectionProvider {
  private tokenInfo: SuperhumanTokenInfo;
  private conn?: SuperhumanConnection;

  constructor(tokenInfo: SuperhumanTokenInfo, conn?: SuperhumanConnection) {
    this.tokenInfo = tokenInfo;
    this.conn = conn;
  }

  /**
   * Returns a TokenInfo-compatible shim so existing code that reads
   * token.accessToken, token.isMicrosoft, etc. continues to work.
   */
  async getToken(email?: string): Promise<TokenInfo> {
    if (email && email !== this.tokenInfo.email) {
      throw new Error(
        `Requested email "${email}" does not match provider email "${this.tokenInfo.email}"`
      );
    }

    const expires = this.tokenInfo.expires ?? Date.now() + 3600_000;

    return {
      accessToken: this.tokenInfo.token,
      email: this.tokenInfo.email,
      expires,
      isMicrosoft: false,
      idToken: this.tokenInfo.token,
      idTokenExpires: expires,
      userPrefix: this.tokenInfo.userPrefix,
      superhumanToken: {
        token: this.tokenInfo.token,
        expires,
      },
    };
  }

  async getCurrentEmail(): Promise<string> {
    return this.tokenInfo.email;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    return {
      email: this.tokenInfo.email,
      isMicrosoft: false,
      provider: "superhuman" as any,
    };
  }

  /** Get the underlying token info (for reconstructing with a CDP connection) */
  getTokenInfo(): SuperhumanTokenInfo {
    return this.tokenInfo;
  }

  async disconnect(): Promise<void> {
    if (this.conn) {
      const { disconnect } = await import("./superhuman-api");
      await disconnect(this.conn);
      this.conn = undefined;
    }
  }

  /** Whether a CDP connection is available for portal RPC */
  hasPortal(): boolean {
    return this.conn != null;
  }

  /**
   * Invoke a Superhuman portal RPC method via the CDP connection.
   * Requires hasPortal() === true.
   */
  async portalInvoke(
    service: string,
    method: string,
    args: any[]
  ): Promise<any> {
    if (!this.conn) {
      throw new Error(
        "Cannot call portalInvoke: no CDP connection available"
      );
    }
    return _portalInvoke(this.conn, service, method, args);
  }

  /**
   * Evaluate a JavaScript expression via CDP Runtime.evaluate.
   * Requires hasPortal() === true (i.e. a CDP connection is available).
   */
  async runtimeEvaluate(expression: string): Promise<any> {
    if (!this.conn) {
      throw new Error(
        "Cannot call runtimeEvaluate: no CDP connection available"
      );
    }

    const response = await this.conn.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (response.exceptionDetails) {
      const desc =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "Unknown runtime error";
      throw new Error(`runtimeEvaluate failed: ${desc}`);
    }

    return response.result?.value;
  }

  /**
   * Make an authenticated request to the Superhuman backend API.
   * On 401/403, attempts one CDP token refresh and retries.
   */
  async backendFetch(path: string, options?: RequestInit): Promise<any> {
    const result = await this._doFetch(path, options);
    if (result !== _AUTH_FAILED) return result;

    // 401/403 — try refreshing token via CDP and retry once
    const refreshed = await refreshTokenViaCDP(this.tokenInfo.email);
    if (!refreshed?.superhumanToken) return null;

    this.tokenInfo.token = refreshed.superhumanToken.token;
    this.tokenInfo.expires = refreshed.superhumanToken.expires;

    const retry = await this._doFetch(path, options);
    return retry === _AUTH_FAILED ? null : retry;
  }

  private async _doFetch(path: string, options?: RequestInit): Promise<any> {
    const url = `${SUPERHUMAN_BACKEND_BASE}${path}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${this.tokenInfo.token}`,
        "Content-Type": "text/plain;charset=UTF-8",
      },
    });

    if (response.status === 401 || response.status === 403) {
      return _AUTH_FAILED;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Superhuman API error: ${response.status} ${response.statusText} — ${errorBody}`
      );
    }

    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
