/**
 * Inbox Module
 *
 * Functions for listing and searching inbox threads via Superhuman's internal APIs.
 */

import type { SuperhumanConnection } from "./superhuman-api";
import { getToken, searchGmailDirect } from "./token-api";
import { listAccounts } from "./accounts";

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
}

export interface SearchOptions {
  query: string;
  limit?: number;
  /**
   * When true, use direct Gmail/MS Graph API for search.
   * This searches ALL emails including archived/done items.
   * Default (false) uses Superhuman's inbox-only search.
   */
  includeDone?: boolean;
}

/**
 * List threads from the current inbox view
 */
export async function listInbox(
  conn: SuperhumanConnection,
  options: ListInboxOptions = {}
): Promise<InboxThread[]> {
  const { Runtime } = conn;
  const limit = options.limit ?? 10;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          // Get thread list from current view
          const threadList = window.ViewState?.threadListState?._list?._sortedList?.sorted;
          if (!threadList || !Array.isArray(threadList)) return [];

          const threads = [];
          const identityMap = window.GoogleAccount?.threads?.identityMap;
          if (!identityMap) return [];

          for (let i = 0; i < Math.min(threadList.length, ${limit}); i++) {
            const ref = threadList[i];
            if (!ref?.id) continue;

            const thread = identityMap.get(ref.id);
            if (!thread?._threadModel) continue;

            const model = thread._threadModel;
            const messages = model.messages || [];
            const lastMessage = messages[messages.length - 1];

            // Name might be a function or string
            const fromObj = lastMessage?.from;
            let fromName = '';
            if (fromObj) {
              if (typeof fromObj.displayName === 'string') fromName = fromObj.displayName;
              else if (typeof fromObj.displayName === 'function') fromName = fromObj.displayName();
              else if (typeof fromObj.name === 'string') fromName = fromObj.name;
              else if (typeof fromObj.name === 'function') fromName = fromObj.name();
            }
            // Date might be in rawJson.date or date (as string or object)
            const msgDate = lastMessage?.rawJson?.date ||
                           (typeof lastMessage?.date === 'string' ? lastMessage.date : '');
            threads.push({
              id: model.id,
              subject: model.subject || '(no subject)',
              from: {
                email: lastMessage?.from?.email || '',
                name: fromName,
              },
              date: msgDate,
              snippet: lastMessage?.snippet || '',
              labelIds: model.labelIds || [],
              messageCount: messages.length,
            });
          }

          return threads;
        } catch (e) {
          return [];
        }
      })()
    `,
    returnByValue: true,
  });

  return (result.result.value as InboxThread[]) || [];
}

/**
 * Search threads using Superhuman's internal search API or direct Gmail/MS Graph API.
 *
 * By default, uses Superhuman's internal API which only searches inbox.
 * When includeDone is true, uses direct Gmail/MS Graph API which searches
 * ALL emails including archived/done items.
 *
 * Note: Superhuman's threadInternal.listAsync ignores the query parameter,
 * so the default mode effectively returns top inbox threads regardless of query.
 * Use includeDone=true for actual search functionality.
 */
export async function searchInbox(
  conn: SuperhumanConnection,
  options: SearchOptions
): Promise<InboxThread[]> {
  const { query, limit = 10, includeDone = false } = options;

  // Use direct API when includeDone is requested
  if (includeDone) {
    // Get current account email to extract token
    const accounts = await listAccounts(conn);
    const currentAccount = accounts.find(a => a.isCurrent);

    if (!currentAccount) {
      throw new Error("No current account found");
    }

    const token = await getToken(conn, currentAccount.email);
    return searchGmailDirect(token, query, limit);
  }

  // Default: use Superhuman's internal API (note: query is ignored by the API)
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const response = await window.GoogleAccount.portal.invoke(
            "threadInternal",
            "listAsync",
            ["INBOX", { limit: ${limit}, filters: [], query: ${JSON.stringify(query)} }]
          );

          if (!response?.threads) return [];

          return response.threads.map(t => {
            // Thread data is nested in json property
            const thread = t.json || t;
            const messages = thread.messages || [];
            const lastMessage = messages[messages.length - 1];

            return {
              id: thread.id,
              subject: thread.subject || lastMessage?.subject || '(no subject)',
              from: {
                email: lastMessage?.from?.email || '',
                name: lastMessage?.from?.name || lastMessage?.from?.displayName || '',
              },
              date: lastMessage?.date || '',
              snippet: lastMessage?.snippet || '',
              labelIds: thread.labelIds || lastMessage?.labelIds || [],
              messageCount: messages.length,
            };
          });
        } catch (e) {
          return [];
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  return (result.result.value as InboxThread[]) || [];
}
