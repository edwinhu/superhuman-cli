/**
 * Inbox Module
 *
 * Functions for listing and searching inbox threads via direct Gmail/MS Graph API.
 */

import type { ConnectionProvider } from "./connection-provider";
import {
  searchGmailDirect,
  streamSearchGmailDirect,
  streamListInboxDirect,
  listInboxDirect,
  listLabelsDirect,
  type TokenInfo,
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
  /** When true, only return unread emails */
  unreadOnly?: boolean;
  /** When true, exclude threads where the user was the last sender */
  needsReply?: boolean;
  /** Filter to threads that have ANY of these label names */
  labels?: string[];
  /**
   * Filter by split inbox classification.
   * "important" = Gmail category:personal / Outlook inferenceClassification:focused
   * "other" = Gmail -category:personal / Outlook inferenceClassification:other
   * Applied server-side via provider API query — no CDP needed.
   */
  splitInbox?: "important" | "other";
  /** Filter by Superhuman AI label (e.g., "Respond", "Meeting", "News") */
  aiLabel?: string;
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
  const unreadOnly = options.unreadOnly ?? false;
  const needsReply = options.needsReply ?? false;
  const labels = options.labels ?? [];
  const splitInbox = options.splitInbox;
  const aiLabel = options.aiLabel;
  const token = await provider.getToken();

  // --split and --ai-label are applied server-side by listInboxDirect (query/filter parameter).
  // --needs-reply and --label are client-side filters, so over-fetch to compensate.
  const hasClientFilters = needsReply || labels.length > 0;
  const fetchLimit = hasClientFilters ? Math.max(limit * 3, 50) : limit;
  let threads = await listInboxDirect(token, fetchLimit, focusedOnly, unreadOnly, splitInbox, aiLabel);

  // Apply --label filter
  if (labels.length > 0) {
    threads = await filterByLabels(token, threads, labels);
  }

  // Apply --needs-reply filter
  if (needsReply) {
    threads = filterNeedsReply(token, threads);
  }

  // Trim to requested limit after filtering
  return threads.slice(0, limit);
}

/**
 * Filter threads to only those with ANY of the specified label names.
 * Resolves label names to IDs first.
 */
async function filterByLabels(
  token: TokenInfo,
  threads: InboxThread[],
  labelNames: string[]
): Promise<InboxThread[]> {
  // For Gmail, labelIds are already on each thread from the search
  // For Outlook, we don't have labelIds — skip label filtering (labels don't apply)
  if (token.isMicrosoft) {
    // Outlook doesn't have Gmail-style labels
    return threads;
  }

  // Resolve label names to IDs
  const allLabels = await listLabelsDirect(token);
  const nameToId = new Map<string, string>();
  for (const label of allLabels) {
    nameToId.set(label.name.toLowerCase(), label.id);
  }

  const targetIds = new Set<string>();
  for (const name of labelNames) {
    const id = nameToId.get(name.toLowerCase());
    if (id) {
      targetIds.add(id);
    } else {
      // Try using name as ID directly (user might pass label ID)
      targetIds.add(name);
    }
  }

  return threads.filter((thread) =>
    thread.labelIds.some((id) => targetIds.has(id))
  );
}

/**
 * Filter out threads where the user was the last sender.
 *
 * Uses from.email on each thread:
 * - Gmail: from shows the last message sender (reliable)
 * - Outlook: from shows the original sender, not last (imperfect but avoids N API calls)
 */
function filterNeedsReply(
  token: TokenInfo,
  threads: InboxThread[]
): InboxThread[] {
  const userEmail = token.email.toLowerCase();
  return threads.filter((thread) => {
    // Single-message threads always pass (new, unanswered)
    if (thread.messageCount <= 1) return true;
    // Exclude if user was the last sender
    return thread.from.email.toLowerCase() !== userEmail;
  });
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
      const path = `/me/mailFolders/Inbox/messages?$search="${encodeURIComponent(query)}"&$top=${limit}&$select=id,conversationId,subject,from,receivedDateTime,bodyPreview,flag`;
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
        flag?: { flagStatus: string };
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
          labelIds: [
            ...(latest.flag?.flagStatus === "flagged" ? ["FLAGGED"] : []),
          ],
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

/**
 * Stream inbox threads as they arrive, applying client-side filters on the fly.
 * Yields each thread as soon as it's fetched and passes all filters.
 */
export async function* streamListInbox(
  provider: ConnectionProvider,
  options: ListInboxOptions = {}
): AsyncGenerator<InboxThread> {
  const limit = options.limit ?? 10;
  const focusedOnly = options.focusedOnly ?? false;
  const unreadOnly = options.unreadOnly ?? false;
  const needsReply = options.needsReply ?? false;
  const labels = options.labels ?? [];
  const splitInbox = options.splitInbox;
  const aiLabel = options.aiLabel;
  const token = await provider.getToken();

  // Resolve label IDs once if we need label filtering
  let targetLabelIds: Set<string> | null = null;
  if (labels.length > 0 && !token.isMicrosoft) {
    const allLabels = await listLabelsDirect(token);
    const nameToId = new Map<string, string>();
    for (const label of allLabels) {
      nameToId.set(label.name.toLowerCase(), label.id);
    }
    targetLabelIds = new Set<string>();
    for (const name of labels) {
      const id = nameToId.get(name.toLowerCase());
      if (id) {
        targetLabelIds.add(id);
      } else {
        targetLabelIds.add(name);
      }
    }
  }

  const hasClientFilters = needsReply || labels.length > 0;
  const fetchLimit = hasClientFilters ? Math.max(limit * 3, 50) : limit;
  const userEmail = token.email.toLowerCase();

  let yielded = 0;
  for await (const thread of streamListInboxDirect(token, fetchLimit, focusedOnly, unreadOnly, splitInbox, aiLabel)) {
    if (yielded >= limit) break;

    // Apply --label filter
    if (targetLabelIds !== null) {
      if (!thread.labelIds.some((id) => targetLabelIds!.has(id))) {
        continue;
      }
    }

    // Apply --needs-reply filter
    if (needsReply) {
      if (thread.messageCount > 1 && thread.from.email.toLowerCase() === userEmail) {
        continue;
      }
    }

    yield thread;
    yielded++;
  }
}

/**
 * Stream search results as they arrive.
 * Yields each thread as soon as it's fetched from the API.
 */
export async function* streamSearchInbox(
  provider: ConnectionProvider,
  options: SearchOptions
): AsyncGenerator<InboxThread> {
  const { query, limit = 10, includeDone = false } = options;
  const token = await provider.getToken();

  if (includeDone) {
    yield* streamSearchGmailDirect(token, query, limit);
  } else {
    if (token.isMicrosoft) {
      // MS Graph: bulk fetch then yield
      const threads = await searchInbox(provider, options);
      for (const thread of threads) {
        yield thread;
      }
    } else {
      const inboxQuery = `label:INBOX ${query}`;
      yield* streamSearchGmailDirect(token, inboxQuery, limit);
    }
  }
}
