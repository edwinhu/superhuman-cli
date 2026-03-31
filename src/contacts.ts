/**
 * Contacts Module
 *
 * Functions for searching contacts.
 * Provider-specific OAuth (Gmail/MS Graph) has been removed.
 * TODO: add MCP contacts support when available.
 */

import type { ConnectionProvider } from "./connection-provider";

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
 */
export interface SearchContactsOptions {
  limit?: number;
  includeTeamMembers?: boolean;
}

/**
 * Search contacts by name or email prefix.
 *
 * @param provider - The connection provider
 * @param query - The search query (name or email prefix)
 * @param options - Optional search options
 * @returns Array of matching contacts sorted by relevance
 */
export async function searchContacts(
  _provider: ConnectionProvider,
  _query: string,
  _options?: SearchContactsOptions
): Promise<Contact[]> {
  throw new Error(
    "Not yet supported: contacts require MCP provider (not yet available). TODO: add MCP contacts support"
  );
}

/**
 * Resolve a recipient string to an email address.
 *
 * If the input is already an email address (contains @), returns it unchanged.
 * Otherwise, would search contacts for the best match.
 *
 * @param provider - The connection provider
 * @param recipient - Email address or name to resolve
 * @returns The resolved email address, or original input if not resolved
 */
export async function resolveRecipient(
  _provider: ConnectionProvider,
  recipient: string
): Promise<string> {
  // If already an email, return as-is
  if (recipient.includes("@")) {
    return recipient;
  }

  throw new Error(
    "Not yet supported: contacts require MCP provider (not yet available). TODO: add MCP contacts support"
  );
}
