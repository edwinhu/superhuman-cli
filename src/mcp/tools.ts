/**
 * MCP Tools Definition
 *
 * Defines the MCP tools that wrap Superhuman automation functions.
 */

import { z } from "zod";
import {
  connectToSuperhuman,
  openCompose,
  addRecipient,
  setSubject,
  setBody,
  saveDraft,
  sendDraft,
  disconnect,
  getDraftState,
  textToHtml,
  type SuperhumanConnection,
} from "../superhuman-api";
import { listInbox, searchInbox } from "../inbox";
import { readThread } from "../read";

const CDP_PORT = 9333;

/**
 * Shared schema for email composition (draft and send use the same fields)
 */
export const EmailSchema = z.object({
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body content (plain text or HTML)"),
  cc: z.string().optional().describe("CC recipient email address (optional)"),
  bcc: z.string().optional().describe("BCC recipient email address (optional)"),
});

export const DraftSchema = EmailSchema;
export const SendSchema = EmailSchema;

/**
 * Zod schema for inbox search parameters
 */
export const SearchSchema = z.object({
  query: z.string().describe("Search query string"),
  limit: z.number().optional().describe("Maximum number of results to return (default: 10)"),
});

/**
 * Zod schema for inbox listing
 */
export const InboxSchema = z.object({
  limit: z.number().optional().describe("Maximum number of threads to return (default: 10)"),
});

/**
 * Zod schema for reading a thread
 */
export const ReadSchema = z.object({
  threadId: z.string().describe("The thread ID to read"),
});

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

function successResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Compose an email (shared logic for draft and send)
 */
async function composeEmail(
  args: z.infer<typeof EmailSchema>
): Promise<{ conn: SuperhumanConnection; draftKey: string }> {
  const conn = await connectToSuperhuman(CDP_PORT);
  if (!conn) {
    throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
  }

  const draftKey = await openCompose(conn);
  if (!draftKey) {
    await disconnect(conn);
    throw new Error("Failed to open compose window");
  }

  await addRecipient(conn, args.to);
  if (args.subject) await setSubject(conn, args.subject);
  if (args.body) await setBody(conn, textToHtml(args.body));

  return { conn, draftKey };
}

/**
 * Handler for superhuman_draft tool
 */
export async function draftHandler(args: z.infer<typeof DraftSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    const composed = await composeEmail(args);
    conn = composed.conn;

    await saveDraft(conn);
    const state = await getDraftState(conn);

    return successResult(
      `Draft created successfully.\nTo: ${args.to}\nSubject: ${args.subject}\nDraft ID: ${state?.id || composed.draftKey}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to create draft: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_send tool
 */
export async function sendHandler(args: z.infer<typeof SendSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    const composed = await composeEmail(args);
    conn = composed.conn;

    const sent = await sendDraft(conn);
    if (!sent) {
      throw new Error("Failed to send email");
    }

    return successResult(`Email sent successfully.\nTo: ${args.to}\nSubject: ${args.subject}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to send email: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_search tool
 */
export async function searchHandler(args: z.infer<typeof SearchSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const { Runtime } = conn;
    const limit = args.limit ?? 10;

    const searchResult = await Runtime.evaluate({
      expression: `
        (async () => {
          try {
            const portal = window.GoogleAccount?.portal;
            if (!portal) return { error: 'Superhuman portal not found' };

            const listResult = await portal.invoke("threadInternal", "listAsync", [
              "INBOX",
              { limit: ${limit}, filters: [], query: ${JSON.stringify(args.query)} }
            ]);

            const threads = listResult?.threads || [];
            return {
              results: threads.slice(0, ${limit}).map(t => {
                const json = t.json || {};
                const shData = t.superhumanData || {};

                let firstMessage = null;
                if (shData.messages && typeof shData.messages === 'object') {
                  const msgKeys = Object.keys(shData.messages);
                  if (msgKeys.length > 0) {
                    const msg = shData.messages[msgKeys[0]];
                    firstMessage = msg.draft || msg;
                  }
                } else if (json.messages && json.messages.length > 0) {
                  firstMessage = json.messages[0];
                }

                return {
                  id: json.id || '',
                  from: firstMessage?.from?.email || '',
                  subject: firstMessage?.subject || json.snippet || '',
                  snippet: firstMessage?.snippet || json.snippet || '',
                  date: firstMessage?.date || firstMessage?.clientCreatedAt || ''
                };
              })
            };
          } catch (err) {
            return { error: err.message };
          }
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });

    const result = searchResult.result.value as {
      results?: Array<{ id: string; from: string; subject: string; snippet: string; date: string }>;
      error?: string;
    };

    if (result.error) {
      throw new Error(result.error);
    }

    const results = result.results || [];

    if (results.length === 0) {
      return successResult(`No results found for query: "${args.query}"`);
    }

    const resultsText = results
      .map((r, i) => `${i + 1}. From: ${r.from}\n   Subject: ${r.subject}\n   Date: ${r.date}\n   Snippet: ${r.snippet}`)
      .join("\n\n");

    return successResult(`Found ${results.length} result(s) for query: "${args.query}"\n\n${resultsText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to search inbox: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_inbox tool
 */
export async function inboxHandler(args: z.infer<typeof InboxSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const threads = await listInbox(conn, { limit: args.limit ?? 10 });

    if (threads.length === 0) {
      return successResult("No emails in inbox");
    }

    const resultsText = threads
      .map((t, i) => {
        const from = t.from.name || t.from.email;
        return `${i + 1}. From: ${from}\n   Subject: ${t.subject}\n   Date: ${t.date}\n   Snippet: ${t.snippet.substring(0, 100)}...`;
      })
      .join("\n\n");

    return successResult(`Inbox (${threads.length} threads):\n\n${resultsText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to list inbox: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

/**
 * Handler for superhuman_read tool
 */
export async function readHandler(args: z.infer<typeof ReadSchema>): Promise<ToolResult> {
  let conn: SuperhumanConnection | null = null;

  try {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error("Could not connect to Superhuman. Make sure it's running with --remote-debugging-port=9333");
    }

    const messages = await readThread(conn, args.threadId);

    if (messages.length === 0) {
      return errorResult(`Thread not found: ${args.threadId}`);
    }

    const messagesText = messages
      .map((msg, i) => {
        const from = msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email;
        const to = msg.to.map(r => r.email).join(", ");
        const cc = msg.cc.length > 0 ? `\nCc: ${msg.cc.map(r => r.email).join(", ")}` : "";
        return `--- Message ${i + 1} ---\nFrom: ${from}\nTo: ${to}${cc}\nDate: ${msg.date}\nSubject: ${msg.subject}\n\n${msg.snippet}`;
      })
      .join("\n\n");

    return successResult(`Thread: ${messages[0].subject}\n\n${messagesText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to read thread: ${message}`);
  } finally {
    if (conn) await disconnect(conn);
  }
}

