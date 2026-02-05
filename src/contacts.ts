/**
 * Contacts Module
 *
 * Functions for searching contacts via direct Gmail/MS Graph API.
 * Works with both Google and Microsoft/Outlook accounts.
 */

import type { SuperhumanConnection } from "./superhuman-api";
import {
  type TokenInfo,
  getToken,
  searchContactsDirect,
} from "./token-api";
import { listAccounts } from "./accounts";

/**
 * Represents a contact returned from contact search.
 *
 * @property email - The contact's email address
 * @property name - The contact's display name (optional)
 * @property score - Relevance score from the search (optional, higher is more relevant)
 */
export interface Contact {
  email: string;
  name?: string;
  score?: number;
}

/**
 * Options for searching contacts.
 *
 * @property limit - Maximum number of contacts to return (default: 20)
 * @property includeTeamMembers - Whether to include team members in results (default: true)
 *                                Note: This option is not supported by direct API, kept for compatibility.
 */
export interface SearchContactsOptions {
  limit?: number;
  includeTeamMembers?: boolean;
}

/**
 * Get token for the current account.
 */
async function getCurrentToken(conn: SuperhumanConnection): Promise<TokenInfo> {
  const accounts = await listAccounts(conn);
  const currentAccount = accounts.find((a) => a.isCurrent);

  if (!currentAccount) {
    throw new Error("No current account found");
  }

  return getToken(conn, currentAccount.email);
}

/**
 * Search contacts by name or email prefix.
 *
 * Uses direct Google People API or MS Graph People API for contact search.
 *
 * @param conn - The Superhuman connection
 * @param query - The search query (name or email prefix)
 * @param options - Optional search options
 * @returns Array of matching contacts sorted by relevance
 */
export async function searchContacts(
  conn: SuperhumanConnection,
  query: string,
  options?: SearchContactsOptions
): Promise<Contact[]> {
  const limit = options?.limit ?? 20;
  const token = await getCurrentToken(conn);
  return searchContactsDirect(token, query, limit);
}

/**
 * Resolve a recipient string to an email address.
 *
 * If the input is already an email address (contains @), returns it unchanged.
 * Otherwise, searches contacts and returns the email of the best match.
 * If no match is found, returns the original input unchanged.
 *
 * @param conn - The Superhuman connection
 * @param recipient - Email address or name to resolve
 * @returns The resolved email address, or original input if not resolved
 */
export async function resolveRecipient(
  conn: SuperhumanConnection,
  recipient: string
): Promise<string> {
  // If already an email, return as-is
  if (recipient.includes("@")) {
    return recipient;
  }

  // Search contacts
  const contacts = await searchContacts(conn, recipient, { limit: 1 });

  // Return best match's email, or original if no matches
  const first = contacts[0];
  if (first && first.email) {
    return first.email;
  }

  return recipient;
}
