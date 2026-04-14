/**
 * Snippets API
 *
 * Fetches and manages Superhuman snippets (reusable email templates).
 * Snippets are stored as drafts with action: "snippet" in the backend.
 */

import type { UserInfo } from "./draft-api";

const SUPERHUMAN_BACKEND = "https://mail.superhuman.com/~backend";

export interface Snippet {
  id: string;
  threadId: string;
  name: string;
  body: string;
  subject: string;
  snippet: string;
  to: string[];
  cc: string[];
  bcc: string[];
  sends: number;
  lastSentAt: string | null;
}

interface DraftEntry {
  draft: {
    id: string;
    threadId?: string;
    action: string;
    name: string | null;
    body: string;
    subject?: string;
    snippet?: string;
    // Recipients may be strings ("Name <email>" or "email") or
    // {email, name} objects depending on how the snippet was created.
    to?: Array<string | { email: string; name?: string }>;
    cc?: Array<string | { email: string; name?: string }>;
    bcc?: Array<string | { email: string; name?: string }>;
  };
  snippetAnalytics?: {
    sends?: number;
    lastSentAt?: string | null;
  };
}

/**
 * Normalize a single recipient value to a string.
 * Handles both plain email strings and {email, name} objects.
 */
function normalizeRecipient(r: string | { email: string; name?: string }): string {
  if (typeof r === "string") return r;
  return r.name ? `${r.name} <${r.email}>` : r.email;
}

/**
 * Normalize a recipients array to string[].
 * Handles arrays of strings, objects, or a mix.
 */
function normalizeRecipients(
  list: Array<string | { email: string; name?: string }> | undefined
): string[] {
  if (!list || list.length === 0) return [];
  return list.map(normalizeRecipient);
}

interface GetThreadsResponse {
  // v3 format: threadList with messages as an object keyed by draft ID
  threadList?: Array<{
    thread: {
      historyId?: number;
      messages: Record<string, DraftEntry>;
    };
  }>;
  // Legacy format: threads with messages as an array
  threads?: Array<{
    id: string;
    messages: Array<DraftEntry>;
  }>;
}

/**
 * Fetch all snippets for the current account.
 */
export async function listSnippets(
  userInfo: UserInfo,
  options?: { limit?: number }
): Promise<Snippet[]> {
  const limit = options?.limit ?? 100;

  const response = await fetch(`${SUPERHUMAN_BACKEND}/v3/userdata.getThreads`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      Authorization: `Bearer ${userInfo.token}`,
    },
    body: JSON.stringify({
      filter: { type: "snippet" },
      offset: 0,
      limit,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as GetThreadsResponse;

  const snippets: Snippet[] = [];

  // Collect all draft entries from either response format
  const entries: DraftEntry[] = [];

  if (data.threadList) {
    // v3 format: threadList[].thread.messages is an object keyed by draft ID
    for (const item of data.threadList) {
      for (const entry of Object.values(item.thread.messages)) {
        entries.push(entry);
      }
    }
  } else if (data.threads) {
    // Legacy format: threads[].messages is an array
    for (const thread of data.threads) {
      for (const entry of thread.messages) {
        entries.push(entry);
      }
    }
  }

  for (const entry of entries) {
    const draft = entry.draft;
    if (draft?.action === "snippet") {
      snippets.push({
        id: draft.id,
        threadId: draft.threadId || "",
        name: draft.name || "(untitled)",
        body: draft.body,
        subject: draft.subject || "",
        snippet: draft.snippet || "",
        to: normalizeRecipients(draft.to),
        cc: normalizeRecipients(draft.cc),
        bcc: normalizeRecipients(draft.bcc),
        sends: entry.snippetAnalytics?.sends ?? 0,
        lastSentAt: entry.snippetAnalytics?.lastSentAt ?? null,
      });
    }
  }

  return snippets;
}

/**
 * Find a snippet by fuzzy name match.
 * Prefers exact match, then substring match (case-insensitive).
 */
export function findSnippet(snippets: Snippet[], query: string): Snippet | null {
  const q = query.toLowerCase();
  return (
    snippets.find((s) => s.name.toLowerCase() === q) ||
    snippets.find((s) => s.name.toLowerCase().includes(q)) ||
    null
  );
}

/**
 * Replace {var_name} template variables in text.
 */
export function applyVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}

/**
 * Parse --vars "key1=val1,key2=val2" into a Record.
 */
export function parseVars(varsStr: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!varsStr) return vars;

  for (const pair of varsStr.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      const key = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      vars[key] = value;
    }
  }
  return vars;
}
