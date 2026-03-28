/**
 * Read Module
 *
 * Functions for reading thread/message content via direct Gmail / MS Graph APIs.
 */

import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider } from "./mcp-provider";
import { gmailFetch, msgraphFetch } from "./token-api";

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
}

/**
 * Parse a single email address from a header value like "Name <email>" or bare "email".
 */
function parseRecipient(str: string): { email: string; name: string } {
  const trimmed = str.trim();
  if (!trimmed) return { email: "", name: "" };
  const match = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^["']|["']$/g, ""),
      email: match[2],
    };
  }
  return { email: trimmed, name: "" };
}

/**
 * Parse a comma-separated list of email addresses from a header value.
 */
function parseRecipientList(
  header: string
): Array<{ email: string; name: string }> {
  if (!header) return [];
  return header
    .split(",")
    .map(parseRecipient)
    .filter((r) => r.email);
}

/**
 * Read all messages in a thread via direct API calls (Gmail or MS Graph).
 */
export async function readThread(
  provider: ConnectionProvider,
  threadId: string
): Promise<ThreadMessage[]> {
  // Route through MCP if available
  if (provider instanceof McpConnectionProvider) {
    return provider.readThread(threadId);
  }

  const token = await provider.getToken();

  if (token.isMicrosoft) {
    return readThreadMSGraph(token.accessToken, threadId);
  } else {
    return readThreadGmail(token.accessToken, threadId);
  }
}

/**
 * Read thread messages from Gmail API.
 */
async function readThreadGmail(
  accessToken: string,
  threadId: string
): Promise<ThreadMessage[]> {
  const result = await gmailFetch(
    accessToken,
    `/threads/${threadId}?format=full`
  );

  if (!result || !result.messages) {
    return [];
  }

  return result.messages.map((msg: any) => {
    const headers: Array<{ name: string; value: string }> =
      msg.payload?.headers || [];

    const getHeader = (name: string): string => {
      const h = headers.find(
        (h: any) => h.name.toLowerCase() === name.toLowerCase()
      );
      return h?.value || "";
    };

    const fromParsed = parseRecipient(getHeader("From"));

    return {
      id: msg.id,
      threadId: result.id,
      subject: getHeader("Subject") || "(no subject)",
      from: fromParsed,
      to: parseRecipientList(getHeader("To")),
      cc: parseRecipientList(getHeader("Cc")),
      date: getHeader("Date"),
      snippet: msg.snippet || "",
    };
  });
}

/**
 * Read thread messages from MS Graph API.
 * Uses client-side filter by conversationId because $filter on conversationId
 * at /me/messages level returns an InefficientFilter error.
 */
async function readThreadMSGraph(
  accessToken: string,
  conversationId: string
): Promise<ThreadMessage[]> {
  const path = `/me/messages?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,conversationId&$top=50&$orderby=receivedDateTime desc`;
  const result = await msgraphFetch(accessToken, path);

  let messages: any[] = [];
  if (result?.value) {
    messages = result.value.filter(
      (m: any) => m.conversationId === conversationId
    );
    // Sort oldest first for thread reading order
    messages.sort(
      (a: any, b: any) =>
        new Date(a.receivedDateTime).getTime() -
        new Date(b.receivedDateTime).getTime()
    );
  }

  // Fallback: if conversationId is actually a message ID, fetch it directly
  if (messages.length === 0) {
    try {
      const msg = await msgraphFetch(
        accessToken,
        `/me/messages/${conversationId}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,conversationId`
      );
      if (msg) {
        messages = [msg];
      }
    } catch {
      // Not a message ID either
    }
  }

  return messages.map((msg: any) => {
    const mapRecipient = (r: any): { email: string; name: string } => ({
      email: r?.emailAddress?.address || "",
      name: r?.emailAddress?.name || "",
    });

    return {
      id: msg.id,
      threadId: msg.conversationId || conversationId,
      subject: msg.subject || "(no subject)",
      from: mapRecipient(msg.from),
      to: (msg.toRecipients || []).map(mapRecipient),
      cc: (msg.ccRecipients || []).map(mapRecipient),
      date: msg.receivedDateTime || "",
      snippet: msg.bodyPreview || "",
    };
  });
}
