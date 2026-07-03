/**
 * Read Module
 *
 * Functions for reading thread/message content.
 * Routes to Superhuman backend API (SuperhumanProvider).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";
import { readThreadFromDB, getThreadBodiesFromDB } from "./sqlite-search";
import { getCachedToken, loadTokensFromDisk } from "./token-api";

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

    const result = messages.map((m) => toThreadMessage(m, threadId));

    // The `threads` table only stores per-message *snippets* (~200 chars), so
    // `read` would otherwise show truncated content. The full body text lives in
    // the FTS index (thread_search_content.c2content), keyed per-thread, which is
    // the whole thread concatenated oldest→newest. Pull it and attach it to the
    // latest message (its block carries the complete text). Mirrors what
    // `inbox --with-body` already does via getThreadBodiesFromDB. Best-effort:
    // any failure leaves the snippet fallback intact.
    try {
      const ids = result.map((m) => m.id).filter(Boolean);
      if (ids.length > 0) {
        const bodies = getThreadBodiesFromDB(accountEmail, ids);
        if (bodies.size > 0) {
          const latest = result[result.length - 1];
          const full = bodies.get(latest.id) ?? bodies.values().next().value;
          if (full && (!latest.body || latest.body.length < full.length)) {
            latest.body = full;
          }
        }
      }
    } catch {
      // Enrichment is best-effort; fall back to snippets.
    }

    return result;
  } catch {
    return []; // SQLite failed, let caller fall back to network
  }
}

// ---------------------------------------------------------------------------
// MS Graph fallback path (Microsoft/Exchange accounts when SQLite misses)
// ---------------------------------------------------------------------------

/**
 * Read a thread via MS Graph API using conversationId filtering.
 *
 * Used as a fallback when the local SQLite cache misses (e.g. thread not yet
 * opened in Superhuman app, or container environment without Chrome OPFS blobs)
 * AND the Superhuman backend `userdata.getThreads` endpoint returns 400 for
 * Microsoft/Exchange accounts (it does not support MS account requests from CLI).
 *
 * Queries: GET /me/messages?$filter=conversationId eq '{threadId}'&$select=...
 */
function msGraphMsgToThreadMessage(msg: any, fallbackThreadId: string): ThreadMessage {
  const from = msg.from?.emailAddress;
  const toList = (msg.toRecipients || []).map((r: any) => ({
    email: r.emailAddress?.address || "",
    name: r.emailAddress?.name || "",
  }));
  const ccList = (msg.ccRecipients || []).map((r: any) => ({
    email: r.emailAddress?.address || "",
    name: r.emailAddress?.name || "",
  }));

  return {
    id: msg.id || "",
    threadId: msg.conversationId || fallbackThreadId,
    subject: msg.subject || "",
    from: {
      email: from?.address || "",
      name: from?.name || "",
    },
    to: toList,
    cc: ccList,
    date: msg.receivedDateTime || "",
    snippet: msg.bodyPreview || "",
    body: msg.body?.content || undefined,
  };
}

async function readThreadMsGraph(
  threadId: string,
  accessToken: string
): Promise<ThreadMessage[]> {
  const select = [
    "id",
    "subject",
    "from",
    "toRecipients",
    "ccRecipients",
    "receivedDateTime",
    "bodyPreview",
    "body",
    "conversationId",
  ].join(",");

  try {
    // Primary path: threadId is a message ID (what inbox returns). Direct
    // lookup is O(1) and avoids the InefficientFilter 400 that
    // $filter=conversationId causes on /me/messages for many Exchange tenants.
    const directUrl = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(threadId)}?$select=${select}`;
    const directResp = await fetch(directUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (directResp.ok) {
      const msg = await directResp.json() as any;
      const convId = msg.conversationId;

      // We found one message — now fetch the rest of the conversation so
      // `read` shows the full thread, not just one message.
      if (convId) {
        const folders = ["Inbox", "SentItems", "Archive", "DeletedItems"];
        const filterParam = `conversationId eq '${convId}'`;
        // NOTE: Do NOT combine $filter=conversationId with $orderby — Exchange
        // rejects the pair with InefficientFilter (400) ("restriction or sort
        // order is too complex"). We sort client-side below instead.
        const queryParams = `?$filter=${encodeURIComponent(filterParam)}&$select=${select}&$top=50`;

        let items: any[] = [];
        for (const folder of folders) {
          const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages${queryParams}`;
          const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!resp.ok) continue;
          const data = await resp.json() as { value?: any[] };
          items = items.concat(data.value || []);
        }

        if (items.length > 0) {
          // Deduplicate by message id
          const seen = new Set<string>();
          items = items.filter((m) => {
            if (seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
          });
          items.sort(
            (a, b) =>
              new Date(a.receivedDateTime || 0).getTime() -
              new Date(b.receivedDateTime || 0).getTime()
          );
          return items.map((m) => msGraphMsgToThreadMessage(m, threadId));
        }
      }

      // Couldn't expand the conversation — return the single message
      return [msGraphMsgToThreadMessage(msg, threadId)];
    }

    // Fallback: threadId might be a conversationId. Query at folder level
    // (NOT /me/messages which returns InefficientFilter 400 on Exchange).
    const folders = ["Inbox", "SentItems", "Archive", "DeletedItems"];
    const filterParam = `conversationId eq '${threadId}'`;
    // See note above: $filter=conversationId + $orderby → InefficientFilter 400.
    // Sort client-side after fetching.
    const queryParams = `?$filter=${encodeURIComponent(filterParam)}&$select=${select}&$top=50`;

    let items: any[] = [];
    for (const folder of folders) {
      const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages${queryParams}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!resp.ok) continue;
      const data = await resp.json() as { value?: any[] };
      items = items.concat(data.value || []);
    }
    if (items.length === 0) return [];

    // Deduplicate and sort
    const seen = new Set<string>();
    items = items.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    items.sort(
      (a, b) =>
        new Date(a.receivedDateTime || 0).getTime() -
        new Date(b.receivedDateTime || 0).getTime()
    );
    return items.map((m) => msGraphMsgToThreadMessage(m, threadId));
  } catch {
    return [];
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
      // Fall through to MS Graph / backend
    }
  }

  // For Microsoft/Exchange accounts, userdata.getThreads returns 400 — use
  // MS Graph API instead. This is the correct path in container environments
  // where there is no Chrome OPFS blob and no CDP portal.
  await loadTokensFromDisk();
  const cachedToken = await getCachedToken(email);
  if (cachedToken?.isMicrosoft && cachedToken.accessToken) {
    const graphResult = await readThreadMsGraph(threadId, cachedToken.accessToken);
    if (graphResult.length > 0) return graphResult;
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
