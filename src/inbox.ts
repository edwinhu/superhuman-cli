/**
 * Inbox Module
 *
 * Functions for listing and searching inbox threads.
 * Routes to Superhuman backend API (SuperhumanProvider).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";
import { listInboxFromDB, buildFtsMatchExpr } from "./sqlite-search";

export interface InboxThread {
  id: string;
  subject: string;
  from: {
    email: string;
    name: string;
  };
  /** Direct recipients of the latest message (To). */
  to?: { email: string; name: string }[];
  /** CC recipients of the latest message. */
  cc?: { email: string; name: string }[];
  date: string;
  snippet: string;
  labelIds: string[];
  messageCount: number;
  /**
   * True when the account owner sent the LATEST message in the thread (i.e. the
   * thread is "me-last" and does NOT need a reply). Detected from the latest
   * message's `SENT` label — which Superhuman applies to every message you sent
   * regardless of which alias it came from, on both Gmail and Microsoft — so it
   * is alias-proof, unlike comparing `from.email` to a single account address.
   * `from` always holds the last sender; downstream can read it as last_sender.
   */
  isFromMe: boolean;
  /**
   * True when the thread is awaiting a reply from the account owner: it has at
   * least one message and the latest one was NOT sent by the owner.
   * (`awaitingReply === !isFromMe` for non-empty threads.)
   */
  awaitingReply: boolean;
}

/**
 * Determine whether the account owner sent the given message.
 *
 * Primary signal: the `SENT` label, which Superhuman stamps on every message
 * the user sent from ANY linked alias, on both Gmail and Microsoft accounts —
 * so this correctly recognizes replies from aliases that differ from the active
 * `--account` address. Falls back to matching the sender email against the
 * supplied me-set (account address + any known aliases) when the label is
 * absent (older cache rows, provider quirks).
 */
const EMPTY_ME_SET: Set<string> = new Set();

function messageIsFromMe(message: any, meSet: Set<string>): boolean {
  const labelIds: string[] = Array.isArray(message?.labelIds) ? message.labelIds : [];
  if (labelIds.includes("SENT")) return true;
  const from = parseFromField(message?.from);
  return from.email !== "" && meSet.has(from.email.toLowerCase());
}

export interface ListInboxOptions {
  limit?: number;
  /** When true, only return important/primary emails (Gmail: category:primary, Outlook: Focused Inbox) */
  focusedOnly?: boolean;
  /** When true, only return unread emails */
  unreadOnly?: boolean;
  /** When true, exclude threads where the user was the last sender */
  needsReply?: boolean;
  /** Exclude threads where from email/name or subject matches any pattern (case-insensitive substring) */
  exclude?: string[];
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
  const isFromMe = messageIsFromMe(latest, EMPTY_ME_SET);

  return {
    id: latest.id || Object.keys(thread.messages)[0] || "",
    subject: latest.subject || "",
    from: parseFrom(latest.from || ""),
    to: parseRecipients(latest.to),
    cc: parseRecipients(latest.cc),
    date: latest.date || "",
    snippet: latest.snippet || "",
    labelIds: latest.labelIds || [],
    messageCount: messages.length,
    isFromMe,
    awaitingReply: !isFromMe,
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

/**
 * Parse a from field that may be a string or an object with {email, name}.
 * The portal returns from as an object: {email, name, attributes, _domain}.
 */
function parseFromField(from: any): { email: string; name: string } {
  if (!from) return { email: "", name: "" };
  if (typeof from === "string") return parseFrom(from);
  // Object form: {email, name, ...}
  return {
    email: from.email || from.attributes?.email || "",
    name: from.name || "",
  };
}

/**
 * Parse a To/CC field (array of recipients, each a string "Name <email>" or an
 * object {email,name,...}) into a list of {email,name}. Drops entries with no
 * resolvable email. Non-array input yields an empty list.
 */
function parseRecipients(field: any): { email: string; name: string }[] {
  if (!Array.isArray(field)) return [];
  return field.map((r) => parseFromField(r)).filter((r) => r.email);
}

/**
 * Parse a portal listAsync result into InboxThread[].
 *
 * The portal returns an object: { threads: [...], query, startAt, ... }
 * Each thread item has shape: { json: { id, messages: [...] }, listIds, ... }
 * Messages within json.messages are arrays of message objects with
 * subject, from (object), date, snippet, labelIds fields.
 *
 * Also handles legacy flat array format where items carry fields directly
 * (used by tests and older response shapes).
 */
function parsePortalListResult(result: any): InboxThread[] {
  // Portal wraps threads in an object: { threads: [...], ... }
  const rawThreads: any[] = Array.isArray(result)
    ? result
    : Array.isArray(result?.threads)
    ? result.threads
    : [];

  if (rawThreads.length === 0) return [];

  return rawThreads
    .map((item: any): InboxThread | null => {
      // Real portal format: { json: { id, messages: [] }, listIds, ... }
      if (item.json) {
        const json = item.json;
        const threadId: string = json.id || item.id || item.threadId || "";
        // listIds lives on the thread wrapper, not on individual messages
        const threadListIds: string[] = item.listIds || [];

        const messages: any[] = Array.isArray(json.messages)
          ? json.messages
          : typeof json.messages === "object" && json.messages !== null
          ? Object.values(json.messages)
          : [];

        if (messages.length === 0) {
          // Draft threads or threads with no messages yet — include with thread-level metadata
          return {
            id: threadId,
            subject: "",
            from: { email: "", name: "" },
            date: "",
            snippet: "",
            labelIds: threadListIds,
            messageCount: 0,
            isFromMe: false,
            awaitingReply: false,
          };
        }

        // Sort by date ascending, pick the latest message
        messages.sort(
          (a: any, b: any) =>
            new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
        );
        const latest = messages[messages.length - 1];
        // Detect me-last from the LATEST MESSAGE's own labelIds (not the
        // thread-level listIds, which would lose the per-message SENT marker).
        const isFromMe = messageIsFromMe(latest, EMPTY_ME_SET);

        return {
          id: latest.id || threadId,
          subject: latest.subject || "",
          from: parseFromField(latest.from),
          to: parseRecipients(latest.to),
          cc: parseRecipients(latest.cc),
          date: latest.date || "",
          snippet: latest.snippet || "",
          // Prefer thread-level listIds (more complete); fall back to message labelIds
          labelIds: threadListIds.length > 0 ? threadListIds : (latest.labelIds || []),
          messageCount: messages.length,
          isFromMe,
          awaitingReply: !isFromMe,
        };
      }

      // Legacy flat format: { id, threadId, subject, from, date, snippet, labelIds, messageCount }
      {
        const isFromMe = messageIsFromMe(item, EMPTY_ME_SET);
        return {
          id: item.id || item.threadId || "",
          subject: item.subject || "",
          from: parseFromField(item.from),
          to: parseRecipients(item.to),
          cc: parseRecipients(item.cc),
          date: item.date || "",
          snippet: item.snippet || "",
          labelIds: item.labelIds || [],
          messageCount: item.messageCount || 1,
          isFromMe,
          awaitingReply: !isFromMe,
        };
      }
    })
    .filter((t): t is InboxThread => t !== null);
}

/**
 * Try to list inbox threads from the local SQLite database.
 * Returns InboxThread[] on success, or null if no DB found / query failed.
 */
function listInboxSQLite(
  accountEmail: string,
  options: ListInboxOptions
): InboxThread[] | null {
  const limit = options.limit ?? 10;
  const listId = buildGetThreadsFilter(options).listId;
  // me-set is a fallback for the rare message that lacks a SENT label; the
  // active account address is always "me". (Alias replies are already caught by
  // the SENT label, which Superhuman applies regardless of sending alias.)
  const meSet: Set<string> = new Set(
    accountEmail ? [accountEmail.toLowerCase()] : []
  );

  try {
    const rows = listInboxFromDB(accountEmail, listId, limit * 2); // fetch extra for client-side filtering
    if (!rows) return null;

    return rows.map((row) => {
      const json =
        typeof row.json === "string" ? JSON.parse(row.json) : row.json;
      const messages: any[] = Array.isArray(json.messages)
        ? json.messages
        : typeof json.messages === "object" && json.messages !== null
        ? Object.values(json.messages)
        : [];

      if (messages.length === 0) {
        return {
          id: row.threadId,
          subject: "",
          from: { email: "", name: "" },
          date: "",
          snippet: "",
          labelIds: row.labelIds,
          messageCount: 0,
          isFromMe: false,
          awaitingReply: false,
        };
      }

      messages.sort(
        (a: any, b: any) =>
          new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
      );
      const latest = messages[messages.length - 1];
      // Me-last detection uses the latest message's own labelIds, which carry
      // the SENT marker for messages sent from any alias (the row-level
      // labelIds are the thread's list membership, not the message's).
      const isFromMe = messageIsFromMe(latest, meSet);

      return {
        id: latest.id || row.threadId,
        subject: latest.subject || "",
        from: parseFromField(latest.from),
        to: parseRecipients(latest.to),
        cc: parseRecipients(latest.cc),
        date: latest.date || "",
        snippet: latest.snippet || "",
        labelIds: row.labelIds,
        messageCount: messages.length,
        isFromMe,
        awaitingReply: !isFromMe,
      };
    });
  } catch {
    return null; // SQLite failed, caller falls back to network
  }
}

async function listInboxSuperhuman(
  provider: SuperhumanProvider,
  options: ListInboxOptions = {}
): Promise<InboxThread[]> {
  const limit = options.limit ?? 10;
  const filter = buildGetThreadsFilter(options);
  const isInboxRequest =
    filter.listId === "INBOX" ||
    filter.listId === "SH_IMPORTANT" ||
    filter.listId === "SH_OTHER";

  let threads: InboxThread[];

  // Try SQLite first
  const email = await provider.getCurrentEmail();
  const sqliteThreads = listInboxSQLite(email, options);

  if (sqliteThreads !== null) {
    threads = sqliteThreads;
  } else if (isInboxRequest) {
    // Inbox listing requires portal RPC (the backend getThreads API
    // does not support inbox/listId filters).
    if (!provider.hasPortal()) {
      throw new Error(
        "Inbox listing requires running Superhuman app (portal RPC). " +
          "Run 'superhuman account auth' with the app open."
      );
    }
    const result = await provider.portalInvoke(
      "threadInternal",
      "listAsync",
      [filter.listId, { limit, query: "" }]
    );
    threads = parsePortalListResult(result);
  } else {
    // Non-inbox data (reminders, snippets, etc.) use the backend API
    const data = await provider.backendFetch("/v3/userdata.getThreads", {
      method: "POST",
      body: JSON.stringify({ filter, offset: 0, limit }),
    });
    threads = parseGetThreadsResponse(data);
  }

  // Client-side filters
  if (options.unreadOnly) {
    threads = threads.filter((t) =>
      t.labelIds.some((l) => l === "UNREAD")
    );
  }

  if (options.needsReply) {
    // Exclude threads where the owner was the last sender. `isFromMe` is derived
    // from the latest message's SENT label, so it recognizes replies sent from
    // ANY of the owner's aliases — not just the active --account address (the
    // old `from.email === userEmail` check leaked alias-sent threads). The
    // email fallback below covers the rare cached message with no SENT label.
    const userEmail = (await provider.getCurrentEmail()).toLowerCase();
    threads = threads.filter(
      (t) => !t.isFromMe && t.from.email.toLowerCase() !== userEmail
    );
  }

  if (options.exclude?.length) {
    const patterns = options.exclude.map((p) => p.toLowerCase());
    threads = threads.filter((t) => {
      const fromEmail = t.from.email.toLowerCase();
      const fromName = t.from.name.toLowerCase();
      const subject = t.subject.toLowerCase();
      return !patterns.some(
        (p) => fromEmail.includes(p) || fromName.includes(p) || subject.includes(p)
      );
    });
  }

  if (options.labels?.length) {
    const labelSet = new Set(options.labels.map((l) => l.toLowerCase()));
    threads = threads.filter((t) =>
      t.labelIds.some((l) => labelSet.has(l.toLowerCase()))
    );
  }

  if (options.aiLabel) {
    // Superhuman's AI categorizes threads with labels stored in labelIds as
    // "<Name> (Superhuman/AI)" — e.g. "Respond (Superhuman/AI)", "News
    // (Superhuman/AI)", "Meeting (Superhuman/AI)", "Waiting (Superhuman/AI)".
    // Accept short names ("Respond"), comma-separated lists ("Respond,Meeting"),
    // or a full label string; match case-insensitively. Keep a thread if it
    // carries ANY of the requested AI labels.
    const wanted = options.aiLabel
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) =>
        /\(superhuman\/ai\)\s*$/i.test(s)
          ? s.toLowerCase()
          : `${s} (superhuman/ai)`.toLowerCase()
      );
    if (wanted.length) {
      threads = threads.filter((t) =>
        t.labelIds.some((l) => wanted.includes(l.toLowerCase()))
      );
    }
  }

  return threads.slice(0, limit);
}

/**
 * Build the FTS3 SQL fragment and params for a keyword query.
 * The fragment is the SELECT...FROM...WHERE part (no ORDER BY) that
 * SearchTable.query() wraps in: WITH search AS ({fragment} ORDER BY rowid DESC LIMIT ?)
 *
 * The MATCH expression is built by the shared `buildFtsMatchExpr` parser so the
 * portal FTS path honors the same Gmail-style operators (subject:/from:/to:/
 * is:starred/in:sent/-negation) as the direct SQLite path.
 */
function buildFtsQuery(queryStr: string): { sql: string; params: string[] } {
  const ellipsis = "\u2026";
  const sql = [
    "SELECT rowid, thread_id,",
    `SNIPPET(thread_search, '<b>', '</b>', '${ellipsis}', 1, -64) AS subject,`,
    `SNIPPET(thread_search, '<b>', '</b>', '${ellipsis}', 2, -15) AS snippet`,
    "FROM thread_search",
    "WHERE thread_search MATCH ?",
  ].join(" ");

  return { sql, params: [buildFtsMatchExpr(queryStr)] };
}

async function searchInboxSuperhuman(
  provider: SuperhumanProvider,
  options: SearchOptions
): Promise<InboxThread[]> {
  if (!provider.hasPortal()) {
    // No CDP connection — cannot invoke FTS search via portal.
    // Caller (cmdSearch) falls back to AI search in this case.
    return [];
  }

  const limit = options.limit ?? 50;
  const { sql, params } = buildFtsQuery(options.query);

  const result = await provider.portalInvoke("searchTable", "query", [
    sql,
    params,
    { limit },
  ]);

  return parsePortalSearchResult(result);
}

/**
 * Parse a searchTable.query result into InboxThread[].
 *
 * Each item has: { json (raw string or object), listIds, snippet, needsRender, superhumanData }
 * json.messages is an array of message objects.
 */
function parsePortalSearchResult(result: any): InboxThread[] {
  const rawThreads: any[] = Array.isArray(result?.threads) ? result.threads : [];

  const parsed = rawThreads
    .map((item: any): InboxThread | null => {
      let json: any;
      try {
        json = typeof item.json === "string" ? JSON.parse(item.json) : item.json;
      } catch {
        return null;
      }
      if (!json) return null;

      const threadId: string = json.id || "";
      if (!threadId) return null;

      const messages: any[] = Array.isArray(json.messages)
        ? json.messages
        : typeof json.messages === "object" && json.messages !== null
        ? Object.values(json.messages)
        : [];

      if (messages.length === 0) {
        return {
          id: threadId,
          subject: item.snippet?.replace(/<[^>]*>/g, "") || "",
          from: { email: "", name: "" },
          date: "",
          snippet: item.snippet?.replace(/<[^>]*>/g, "") || "",
          labelIds: item.listIds || [],
          messageCount: 0,
          isFromMe: false,
          awaitingReply: false,
        };
      }

      messages.sort(
        (a: any, b: any) =>
          new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
      );
      const latest = messages[messages.length - 1];
      const isFromMe = messageIsFromMe(latest, EMPTY_ME_SET);

      return {
        id: threadId,
        subject: latest.subject || "",
        from: parseFromField(latest.from),
        to: parseRecipients(latest.to),
        cc: parseRecipients(latest.cc),
        date: latest.date || "",
        snippet: item.snippet?.replace(/<[^>]*>/g, "") || latest.snippet || "",
        labelIds: item.listIds || latest.labelIds || [],
        messageCount: messages.length,
        isFromMe,
        awaitingReply: !isFromMe,
      };
    })
    .filter((t): t is InboxThread => t !== null);

  // Sort by thread date descending (most recent first).
  // FTS returns results by rowid DESC (indexing recency), which means recently
  // forwarded/resent copies surface before the original email. Date sort fixes this.
  parsed.sort(
    (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
  );

  return parsed;
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
