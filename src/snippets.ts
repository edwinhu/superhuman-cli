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

interface GetThreadsResponse {
  threads: Array<{
    id: string;
    messages: Array<{
      id: string;
      draft?: {
        id: string;
        threadId: string;
        action: string;
        name: string | null;
        body: string;
        subject: string;
        snippet: string;
        to: string[];
        cc: string[];
        bcc: string[];
        snippetAnalytics?: {
          sends?: number;
          lastSentAt?: string | null;
        };
      };
    }>;
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
  for (const thread of data.threads ?? []) {
    for (const msg of thread.messages ?? []) {
      const draft = msg.draft;
      if (draft?.action === "snippet") {
        snippets.push({
          id: draft.id,
          threadId: draft.threadId,
          name: draft.name || "(untitled)",
          body: draft.body,
          subject: draft.subject || "",
          snippet: draft.snippet || "",
          to: draft.to || [],
          cc: draft.cc || [],
          bcc: draft.bcc || [],
          sends: draft.snippetAnalytics?.sends ?? 0,
          lastSentAt: draft.snippetAnalytics?.lastSentAt ?? null,
        });
      }
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
