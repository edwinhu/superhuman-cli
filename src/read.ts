/**
 * Read Module
 *
 * Functions for reading thread/message content.
 * Routes to Superhuman backend API (SuperhumanProvider).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";
import { readThreadFromDB } from "./sqlite-search";

export interface ThreadMessage {
  id: string;
  threadId: string;
  subject: string;
  from: {
    email: string;
    name: string;
  };
  to: Array<{ email: string; name: string }>;
  cc: Array<{ email: string; name: string }>;
  date: string;
  snippet: string;
  body?: string;
}

// ---------------------------------------------------------------------------
// Parsing helpers
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
 * Normalize a recipient value into { email, name }.
 * Handles strings (plain email or "Name <email>") and objects.
 */
function parseRecipient(r: any): { email: string; name: string } {
  if (!r) return { email: "", name: "" };
  if (typeof r === "string") return parseFrom(r);
  return { email: r.email || "", name: r.name || "" };
}

/**
 * Normalize a recipients array (may be strings or objects).
 */
function parseRecipients(
  list: any
): Array<{ email: string; name: string }> {
  if (!list) return [];
  if (!Array.isArray(list)) return [parseRecipient(list)];
  return list.map(parseRecipient);
}

/**
 * Convert a raw message object (from portal or backend) into ThreadMessage.
 */
function toThreadMessage(msg: any, fallbackThreadId: string): ThreadMessage {
  return {
    id: msg.id || "",
    threadId: msg.threadId || fallbackThreadId,
    subject: msg.subject || "",
    from: typeof msg.from === "object" && msg.from !== null
      ? { email: msg.from.email || "", name: msg.from.name || "" }
      : parseFrom(msg.from || ""),
    to: parseRecipients(msg.to),
    cc: parseRecipients(msg.cc),
    date: msg.date || "",
    snippet: msg.snippet || "",
    body: msg.body || msg.bodyHtml || undefined,
  };
}

/**
 * Parse a response that has a messages map (keyed by message ID)
 * into a sorted ThreadMessage[].
 */
function parseMessagesMap(
  messagesMap: Record<string, any>,
  threadId: string
): ThreadMessage[] {
  const messages = Object.values(messagesMap) as any[];
  if (messages.length === 0) return [];

  // Sort by date ascending (oldest first — natural reading order)
  messages.sort(
    (a, b) =>
      new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
  );

  return messages.map((m) => toThreadMessage(m, threadId));
}

// ---------------------------------------------------------------------------
// Superhuman portal path
// ---------------------------------------------------------------------------

/**
 * Extract messages array from a portal thread item's json field.
 * Handles both array and object (keyed map) forms.
 */
function extractMessages(json: any): any[] {
  if (!json) return [];
  if (Array.isArray(json.messages)) return json.messages;
  if (typeof json.messages === "object" && json.messages !== null) {
    return Object.values(json.messages);
  }
  return [];
}

async function readThreadPortal(
  provider: SuperhumanProvider,
  threadId: string
): Promise<ThreadMessage[]> {
  // `threadInternal.getAsync` does not exist on the portal — use listAsync instead.
  // The IDs that users pass to `read` are message IDs (the latest message's ID),
  // matching what `superhuman inbox` returns (inbox sets id: latest.id).
  // Strategy: fetch INBOX threads and find the one containing a message with this ID.
  // Use a generous limit; Exchange inboxes can be large so we try up to 200.
  const BATCH_SIZE = 200;
  const result = await provider.portalInvoke("threadInternal", "listAsync", [
    "INBOX",
    { limit: BATCH_SIZE, query: "" },
  ]);

  const rawThreads: any[] = Array.isArray(result)
    ? result
    : Array.isArray(result?.threads)
    ? result.threads
    : [];

  for (const item of rawThreads) {
    const json = item?.json;
    if (!json) continue;

    const messages = extractMessages(json);
    const threadInternalId: string = json.id || "";

    // Match by message ID (users pass the latest message's ID from inbox output)
    // or by thread-level ID as a fallback.
    const isMatch =
      threadInternalId === threadId ||
      messages.some((m: any) => m.id === threadId);

    if (!isMatch) continue;

    // Found the thread — sort messages oldest-first and return.
    messages.sort(
      (a: any, b: any) =>
        new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
    );

    return messages.map((m: any) => toThreadMessage(m, threadInternalId || threadId));
  }

  return [];
}

// ---------------------------------------------------------------------------
// Superhuman backend path
// ---------------------------------------------------------------------------

async function readThreadBackend(
  provider: SuperhumanProvider,
  threadId: string
): Promise<ThreadMessage[]> {
  // Use getThreads with a small limit — the backend doesn't have a
  // single-thread-by-id endpoint, so we fetch and filter client-side.
  // NOTE: `filter: { listId: "INBOX" }` causes a 400 error — the backend
  // does not support listId filters. Omit the filter entirely.
  const data = await provider.backendFetch("/v3/userdata.getThreads", {
    method: "POST",
    body: JSON.stringify({
      filter: {},
      offset: 0,
      limit: 50,
    }),
  });

  if (!data || !data.threadList) return [];

  // Find the thread that contains a message with the matching threadId
  for (const item of data.threadList) {
    const thread = item?.thread;
    if (!thread?.messages) continue;

    const messages = Object.values(thread.messages) as any[];
    // Match by threadId field on any message, or by the thread's own id structure
    const match = messages.some(
      (m: any) =>
        m.threadId === threadId ||
        m.id === threadId ||
        (m.id && threadId.includes(m.id))
    );

    if (match) {
      return parseMessagesMap(thread.messages, threadId);
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// SQLite local path (fastest, no network needed)
// ---------------------------------------------------------------------------

async function readThreadSQLite(
  accountEmail: string,
  threadId: string
): Promise<ThreadMessage[]> {
  try {
    const threadJson = readThreadFromDB(accountEmail, threadId);
    if (!threadJson || !threadJson.messages) return [];

    const messages: any[] = Array.isArray(threadJson.messages)
      ? threadJson.messages
      : Object.values(threadJson.messages as Record<string, unknown>);

    if (messages.length === 0) return [];

    // Sort by date ascending (oldest first — natural reading order)
    messages.sort(
      (a, b) =>
        new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
    );

    return messages.map((m) => toThreadMessage(m, threadId));
  } catch {
    return []; // SQLite failed, let caller fall back to network
  }
}

// ---------------------------------------------------------------------------
// Superhuman combined path
// ---------------------------------------------------------------------------

async function readThreadSuperhuman(
  provider: SuperhumanProvider,
  threadId: string
): Promise<ThreadMessage[]> {
  // Try SQLite first (fastest, no network needed)
  const email = await provider.getCurrentEmail();
  const sqliteResult = await readThreadSQLite(email, threadId);
  if (sqliteResult.length > 0) return sqliteResult;

  // Fall back to portal when available
  if (provider.hasPortal()) {
    try {
      const portalResult = await readThreadPortal(provider, threadId);
      if (portalResult.length > 0) return portalResult;
    } catch {
      // Fall through to backend
    }
  }

  return readThreadBackend(provider, threadId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read all messages in a thread.
 * Routes to SuperhumanProvider (portal / backend).
 */
export async function readThread(
  provider: ConnectionProvider,
  threadId: string
): Promise<ThreadMessage[]> {
  if (provider instanceof SuperhumanProvider) {
    return readThreadSuperhuman(provider, threadId);
  }

  throw new Error(
    "readThread requires a SuperhumanProvider. " +
      "Run 'superhuman account auth' to set up credentials."
  );
}
