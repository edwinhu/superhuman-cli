/**
 * Contacts Module
 *
 * Functions for searching contacts via Superhuman's internal APIs.
 * Works with both Google and Microsoft/Outlook accounts.
 */

import type { SuperhumanConnection } from "./superhuman-api";

/**
 * Represents a contact returned from Superhuman's contact search.
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
 * @property limit - Maximum number of contacts to return (default varies by implementation)
 * @property includeTeamMembers - Whether to include team members in results (default: true)
 */
export interface SearchContactsOptions {
  limit?: number;
  includeTeamMembers?: boolean;
}

/**
 * Search contacts by name prefix.
 *
 * Uses Superhuman's internal contacts service which provides autocomplete
 * functionality for both Google and Microsoft accounts.
 *
 * @param conn - The Superhuman connection
 * @param query - The search query (name prefix)
 * @param options - Optional search options
 * @returns Array of matching contacts sorted by relevance score
 */
export async function searchContacts(
  conn: SuperhumanConnection,
  query: string,
  options?: SearchContactsOptions
): Promise<Contact[]> {
  const { Runtime } = conn;

  const limit = options?.limit ?? 20;
  const includeTeamMembers = options?.includeTeamMembers ?? true;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const query = ${JSON.stringify(query)};
          const limit = ${limit};
          const includeTeamMembers = ${includeTeamMembers};

          const di = window.GoogleAccount?.di;
          if (!di) {
            return { error: "DI container not found", contacts: [] };
          }

          const contacts = di.get?.('contacts');
          if (!contacts) {
            return { error: "contacts service not found", contacts: [] };
          }

          // Ensure contacts are loaded
          await contacts.loadAsync?.();

          // Use the autocomplete API
          if (typeof contacts.recipientListAutoCompleteAsync === 'function') {
            const results = await contacts.recipientListAutoCompleteAsync({
              query,
              limit,
              includeTeamMembers,
            });

            return {
              contacts: (results || []).map(c => ({
                email: c.email,
                name: c.name || c.displayName,
                score: c.score,
              })),
            };
          }

          // Fallback to topContactsAsync if available
          if (typeof contacts.topContactsAsync === 'function') {
            const results = await contacts.topContactsAsync({ query, limit });
            return {
              contacts: (results || []).map(c => ({
                email: c.email,
                name: c.name || c.displayName,
                score: c.score,
              })),
            };
          }

          return { error: "No autocomplete method found", contacts: [] };
        } catch (e) {
          return { error: e.message || "Unknown error", contacts: [] };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  const value = result.result.value as { contacts: Contact[]; error?: string } | null;
  return value?.contacts ?? [];
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
  if (contacts.length > 0 && contacts[0].email) {
    return contacts[0].email;
  }

  return recipient;
}
