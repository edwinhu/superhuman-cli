/**
 * Inbox Module
 *
 * Functions for listing and searching inbox threads.
 * Routes to Superhuman backend API (SuperhumanProvider).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";

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
   */
  splitInbox?: "important" | "other";
  /** Filter by Superhuman AI label (e.g., "Respond", "Meeting", "News") */
  aiLabel?: string;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  /**
   * When true, search ALL emails including archived/done items.
   * Default (false) uses Superhuman's inbox-only search.
   */
  includeDone?: boolean;
}

// ---------------------------------------------------------------------------
// getThreads response parsing
// ---------------------------------------------------------------------------

/**
 * Parse a "from" field which may be plain email or "Name <email>" format.
 */
function parseFrom(from: string): { email: string; name: string } {
  if (!from) return { email: "", name: "" };
  const match = from.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { email: from, name: from };
}

/**
 * Convert a userdata.getThreads response item into an InboxThread.
 * Picks the latest message (by date) from the thread's messages map.
 */
function threadItemToInboxThread(item: any): InboxThread | null {
  const thread = item?.thread;
  if (!thread?.messages) return null;

  const messages = Object.values(thread.messages) as any[];
  if (messages.length === 0) return null;

  // Sort by date descending, pick the latest
  messages.sort(
    (a: any, b: any) =>
      new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
  );
  const latest = messages[0];

  return {
    id: latest.id || Object.keys(thread.messages)[0] || "",
    subject: latest.subject || "",
    from: parseFrom(latest.from || ""),
    date: latest.date || "",
    snippet: latest.snippet || "",
    labelIds: latest.labelIds || [],
    messageCount: messages.length,
  };
}

/**
 * Parse a full getThreads API response into InboxThread[].
 */
function parseGetThreadsResponse(data: any): InboxThread[] {
  if (!data || !data.threadList) return [];
  return data.threadList
    .map(threadItemToInboxThread)
    .filter((t: InboxThread | null): t is InboxThread => t !== null);
}

/**
 * Map ListInboxOptions to the getThreads filter object.
 */
function buildGetThreadsFilter(options: ListInboxOptions): { listId: string } {
  if (options.splitInbox === "important" || options.focusedOnly) {
    return { listId: "SH_IMPORTANT" };
  }
  if (options.splitInbox === "other") {
    return { listId: "SH_OTHER" };
  }
  return { listId: "INBOX" };
}

// ---------------------------------------------------------------------------
// Superhuman backend path
// ---------------------------------------------------------------------------

async function listInboxSuperhuman(
  provider: SuperhumanProvider,
  options: ListInboxOptions = {}
): Promise<InboxThread[]> {
  const limit = options.limit ?? 10;
  const filter = buildGetThreadsFilter(options);

  const data = await provider.backendFetch("/v3/userdata.getThreads", {
    method: "POST",
    body: JSON.stringify({ filter, offset: 0, limit }),
  });

  let threads = parseGetThreadsResponse(data);

  // Client-side filters
  if (options.unreadOnly) {
    threads = threads.filter((t) =>
      t.labelIds.some((l) => l === "UNREAD")
    );
  }

  if (options.needsReply) {
    // Exclude threads where user was the last sender
    const userEmail = (await provider.getCurrentEmail()).toLowerCase();
    threads = threads.filter(
      (t) =>
        t.messageCount <= 1 ||
        t.from.email.toLowerCase() !== userEmail
    );
  }

  if (options.labels?.length) {
    const labelSet = new Set(options.labels.map((l) => l.toLowerCase()));
    threads = threads.filter((t) =>
      t.labelIds.some((l) => labelSet.has(l.toLowerCase()))
    );
  }

  return threads.slice(0, limit);
}

async function searchInboxSuperhuman(
  provider: SuperhumanProvider,
  options: SearchOptions
): Promise<InboxThread[]> {
  const limit = options.limit ?? 10;

  // If portal is available, use portal.invoke for search
  if (provider.hasPortal()) {
    try {
      const result = await provider.portalInvoke(
        "threadInternal",
        "listAsync",
        ["INBOX", { limit, query: options.query }]
      );
      // Portal returns an array of thread objects
      if (Array.isArray(result)) {
        return result.slice(0, limit).map((item: any) => ({
          id: item.id || item.threadId || "",
          subject: item.subject || "",
          from: parseFrom(item.from || ""),
          date: item.date || "",
          snippet: item.snippet || "",
          labelIds: item.labelIds || [],
          messageCount: item.messageCount || 1,
        }));
      }
    } catch {
      // Fall through to AI search
    }
  }

  // Fallback: use ai.askAIProxy for search
  try {
    const data = await provider.backendFetch("/v3/ai.askAIProxy", {
      method: "POST",
      body: JSON.stringify({
        query: options.query,
        available_skills: ["search"],
      }),
    });
    // Parse SSE / search results if available
    if (data?.results && Array.isArray(data.results)) {
      return data.results.slice(0, limit).map((item: any) => ({
        id: item.threadId || item.id || "",
        subject: item.subject || "",
        from: parseFrom(item.from || ""),
        date: item.date || "",
        snippet: item.snippet || "",
        labelIds: item.labelIds || [],
        messageCount: item.messageCount || 1,
      }));
    }
  } catch {
    // Search failed
  }

  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List threads from the current inbox view.
 */
export async function listInbox(
  provider: ConnectionProvider,
  options: ListInboxOptions = {}
): Promise<InboxThread[]> {
  if (provider instanceof SuperhumanProvider) {
    return listInboxSuperhuman(provider, options);
  }
  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Search threads.
 *
 * When includeDone is false (default), only searches inbox threads.
 * When includeDone is true, searches ALL emails including archived/done items.
 */
export async function searchInbox(
  provider: ConnectionProvider,
  options: SearchOptions
): Promise<InboxThread[]> {
  if (provider instanceof SuperhumanProvider) {
    return searchInboxSuperhuman(provider, options);
  }
  throw new Error(
    "SuperhumanProvider required. Run 'superhuman account auth' to authenticate."
  );
}

/**
 * Stream inbox threads as they arrive, applying client-side filters on the fly.
 * Yields each thread as soon as it's fetched and passes all filters.
 */
export async function* streamListInbox(
  provider: ConnectionProvider,
  options: ListInboxOptions = {}
): AsyncGenerator<InboxThread> {
  const threads = await listInbox(provider, options);
  for (const thread of threads) {
    yield thread;
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
  const threads = await searchInbox(provider, options);
  for (const thread of threads) {
    yield thread;
  }
}
