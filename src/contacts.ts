/**
 * Contacts Module
 *
 * Searches Superhuman's local `contacts` table (in the per-account SQLite OPFS
 * blob) directly — no CDP, no provider APIs. Superhuman maintains this table
 * itself with relevance scores and canonical name casing, so it is the same
 * data the desktop client's autocomplete uses.
 */

import {
  searchContactsFromDB,
  listLocalAccounts,
  type LocalContact,
} from "./sqlite-search";

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
 * @property account - Restrict the search to one account's contacts (default: all local accounts)
 */
export interface SearchContactsOptions {
  limit?: number;
  account?: string;
}

function toContact(c: LocalContact): Contact {
  return {
    email: c.email,
    name: c.name || undefined,
    score: c.score ?? undefined,
  };
}

/**
 * Search contacts by name or email substring across local Superhuman accounts.
 *
 * @param query - The search query (name or email fragment)
 * @param options - Optional search options
 * @returns Array of matching contacts, deduped by email, sorted by relevance
 */
export function searchContactsLocal(
  query: string,
  options?: SearchContactsOptions
): Contact[] {
  const limit = options?.limit ?? 20;
  const accounts = options?.account ? [options.account] : listLocalAccounts();

  // Merge across accounts keeping the highest-scored entry per email.
  const byEmail = new Map<string, Contact>();
  for (const account of accounts) {
    const rows = searchContactsFromDB(account, query, limit);
    if (!rows) continue;
    for (const row of rows) {
      const key = row.email.toLowerCase();
      const existing = byEmail.get(key);
      if (!existing || (row.score ?? 0) > (existing.score ?? 0)) {
        byEmail.set(key, toContact(row));
      }
    }
  }

  return [...byEmail.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}

/**
 * Resolve a recipient string to an email address.
 *
 * If the input is already an email address (contains @), returns it unchanged.
 * Otherwise searches local contacts for the best match.
 *
 * @param recipient - Email address or name to resolve
 * @param account - Optional account to restrict the contact search to
 * @returns The resolved email address
 * @throws When the name matches no local contact
 */
export function resolveRecipientLocal(recipient: string, account?: string): string {
  // If already an email, return as-is
  if (recipient.includes("@")) {
    return recipient;
  }

  const best = searchContactsLocal(recipient, { limit: 1, account })[0];
  if (!best?.email) {
    throw new Error(
      `Could not resolve "${recipient}" to an email address (no matching contact)`
    );
  }
  return best.email;
}
