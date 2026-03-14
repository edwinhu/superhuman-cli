/**
 * Inbox Module
 *
 * Functions for listing and searching inbox threads via direct Gmail/MS Graph API.
 */

import type { ConnectionProvider } from "./connection-provider";
import {
  searchGmailDirect,
  listInboxDirect,
} from "./token-api";

export interface InboxThread {
  id: string;
  subject: string;
  from: {
    email: string;
    name: string;
  };
  date: string;
  snippet: string;
  labelIds: string[];
  messageCount: number;
}

export interface ListInboxOptions {
  limit?: number;
  /** When true, only return important/primary emails (Gmail: category:primary, Outlook: Focused Inbox) */
  focusedOnly?: boolean;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  /**
   * When true, use direct Gmail/MS Graph API for search.
   * This searches ALL emails including archived/done items.
   * Default (false) uses Superhuman's inbox-only search.
   *
   * Note: With direct API migration, both modes now use direct API.
   * The difference is that includeDone=true removes label:INBOX filter.
   */
  includeDone?: boolean;
}

/**
 * List threads from the current inbox view
 */
export async function listInbox(
  provider: ConnectionProvider,
  options: ListInboxOptions = {}
): Promise<InboxThread[]> {
  const limit = options.limit ?? 10;
  const focusedOnly = options.focusedOnly ?? false;
  const token = await provider.getToken();
  return listInboxDirect(token, limit, focusedOnly);
}

/**
 * Search threads using direct Gmail/MS Graph API.
 *
 * When includeDone is false (default), only searches inbox threads.
 * When includeDone is true, searches ALL emails including archived/done items.
 */
export async function searchInbox(
  provider: ConnectionProvider,
  options: SearchOptions
): Promise<InboxThread[]> {
  const { query, limit = 10, includeDone = false } = options;
  const token = await provider.getToken();

  if (includeDone) {
    // Search all emails (no inbox filter)
    return searchGmailDirect(token, query, limit);
  } else {
    // Search only inbox threads
    // For Gmail, add label:INBOX to query
    // For MS Graph, listInboxDirect already filters to inbox
    if (token.isMicrosoft) {
      // MS Graph: search within inbox folder
      // Note: MS Graph $search works across all messages, so we use folder filter
      const path = `/me/mailFolders/Inbox/messages?$search="${encodeURIComponent(query)}"&$top=${limit}&$select=id,conversationId,subject,from,receivedDateTime,bodyPreview`;
      const response = await fetch(
        `https://graph.microsoft.com/v1.0${path}`,
        {
          headers: { Authorization: `Bearer ${token.accessToken}` },
        }
      );

      if (!response.ok) {
        return [];
      }

      interface MSGraphMessage {
        id: string;
        conversationId: string;
        subject?: string;
        from?: { emailAddress?: { address?: string; name?: string } };
        receivedDateTime: string;
        bodyPreview?: string;
      }

      const result = await response.json() as { value?: MSGraphMessage[] };
      if (!result.value) {
        return [];
      }

      // Group by conversationId
      const conversationMap = new Map<string, MSGraphMessage[]>();
      for (const msg of result.value) {
        const existing = conversationMap.get(msg.conversationId);
        if (!existing) {
          conversationMap.set(msg.conversationId, [msg]);
        } else {
          existing.push(msg);
        }
      }

      const threads: InboxThread[] = [];
      for (const [convId, messages] of conversationMap) {
        messages.sort((a, b) =>
          new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime()
        );
        const latest = messages[0];

        threads.push({
          id: convId,
          subject: latest.subject || "(no subject)",
          from: {
            email: latest.from?.emailAddress?.address || "",
            name: latest.from?.emailAddress?.name || "",
          },
          date: latest.receivedDateTime,
          snippet: latest.bodyPreview || "",
          labelIds: [],
          messageCount: messages.length,
        });

        if (threads.length >= limit) break;
      }

      return threads;
    } else {
      // Gmail: Add label:INBOX to the query
      const inboxQuery = `label:INBOX ${query}`;
      return searchGmailDirect(token, inboxQuery, limit);
    }
  }
}
