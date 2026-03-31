/**
 * Read Module
 *
 * Functions for reading thread/message content.
 * Routes to Superhuman backend API (SuperhumanProvider).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";

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
    from: parseFrom(msg.from || ""),
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

async function readThreadPortal(
  provider: SuperhumanProvider,
  threadId: string
): Promise<ThreadMessage[]> {
  const result = await provider.portalInvoke("threadInternal", "getAsync", [
    threadId,
    { format: "full" },
  ]);

  if (!result || !result.messages) return [];

  // Portal response: { id, messages: { msgId: {...}, ... } }
  const messagesMap =
    typeof result.messages === "object" && !Array.isArray(result.messages)
      ? result.messages
      : {};

  return parseMessagesMap(messagesMap, threadId);
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
  const data = await provider.backendFetch("/v3/userdata.getThreads", {
    method: "POST",
    body: JSON.stringify({
      filter: { listId: "INBOX" },
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
// Superhuman combined path
// ---------------------------------------------------------------------------

async function readThreadSuperhuman(
  provider: SuperhumanProvider,
  threadId: string
): Promise<ThreadMessage[]> {
  // Prefer portal when available
  if (provider.hasPortal()) {
    try {
      return await readThreadPortal(provider, threadId);
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
