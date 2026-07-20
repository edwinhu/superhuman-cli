/**
 * Outlook Web (OWA) Provider
 *
 * A ConnectionProvider for Microsoft (Exchange Online) accounts driven through
 * the live Outlook Web session's own first-party token — no Superhuman, no new
 * OAuth grant. Sibling to SuperhumanProvider.
 *
 * It carries the account email and exposes a single data primitive,
 * `owaFetch(method, path, body?)`, which fetches a fresh OWA token from the
 * broker (owa-token.ts) and calls the Outlook REST client (outlook-rest-api.ts).
 * CDP is used only by the token broker; verbs speak plain HTTPS + Bearer.
 */

import type { ConnectionProvider, AccountInfo } from "./connection-provider";
import type { TokenInfo } from "./token-api";
import { getOwaToken } from "./owa-token";
import { owaFetch, owaFetchRaw, type OwaFetcher } from "./outlook-rest-api";

export class OutlookWebProvider implements ConnectionProvider {
  constructor(private email: string) {}

  /**
   * TokenInfo-compatible shim so callers that read `token.accessToken`,
   * `token.email`, `token.isMicrosoft` keep working. `isOutlookWeb` marks the
   * access token as an Outlook REST token so verbs route to the OWA backend.
   */
  async getToken(email?: string): Promise<TokenInfo> {
    const tok = await getOwaToken(email || this.email);
    // Adopt the broker's canonical email (decoded from the token) so downstream
    // `me`-detection matches the real mailbox address.
    this.email = tok.email || this.email;
    return {
      accessToken: tok.accessToken,
      email: tok.email,
      expires: tok.expiresOn,
      isMicrosoft: true,
      isOutlookWeb: true,
    };
  }

  async getCurrentEmail(): Promise<string> {
    return this.email;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    return { email: this.email, isMicrosoft: true, provider: "microsoft" };
  }

  async disconnect(): Promise<void> {
    // No persistent connection — the broker manages CDP lifetimes itself.
  }

  /**
   * Fetch a fresh OWA token then call the Outlook REST client. This is the seam
   * verbs and tests use (tests monkeypatch this method to return fixtures).
   */
  async owaFetch(method: string, path: string, body?: any): Promise<any> {
    const tok = await getOwaToken(this.email);
    this.email = tok.email || this.email;
    return owaFetch(tok.accessToken, method, path, body);
  }

  /** Raw (non-JSON) fetch for `$value` MIME exports. */
  async owaFetchRaw(path: string): Promise<Uint8Array> {
    const tok = await getOwaToken(this.email);
    return owaFetchRaw(tok.accessToken, path);
  }

  /** A bound OwaFetcher for the data functions in outlook-rest-api.ts. */
  fetcher(): OwaFetcher {
    return (method, path, body) => this.owaFetch(method, path, body);
  }
}
