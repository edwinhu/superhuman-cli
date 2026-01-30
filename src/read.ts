/**
 * Read Module
 *
 * Functions for reading thread/message content via Superhuman's internal APIs.
 */

import type { SuperhumanConnection } from "./superhuman-api";

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
 * Read all messages in a thread
 */
export async function readThread(
  conn: SuperhumanConnection,
  threadId: string
): Promise<ThreadMessage[]> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const identityMap = window.GoogleAccount?.threads?.identityMap;
          if (!identityMap) return [];

          const thread = identityMap.get(${JSON.stringify(threadId)});
          if (!thread?._threadModel) return [];

          const model = thread._threadModel;
          const messages = model.messages || [];

          // Helper to extract name from recipient object (might be function or string)
          const getName = (r) => {
            if (!r) return '';
            if (typeof r.displayName === 'string') return r.displayName;
            if (typeof r.displayName === 'function') return r.displayName();
            if (typeof r.name === 'string') return r.name;
            if (typeof r.name === 'function') return r.name();
            return '';
          };

          return messages.map(msg => {
            const msgDate = msg.rawJson?.date ||
                           (typeof msg.date === 'string' ? msg.date : '');
            return {
              id: msg.id,
              threadId: model.id,
              subject: msg.subject || model.subject || '(no subject)',
              from: {
                email: msg.from?.email || '',
                name: getName(msg.from),
              },
              to: (msg.to || []).map(r => ({
                email: r.email || '',
                name: getName(r),
              })),
              cc: (msg.cc || []).map(r => ({
                email: r.email || '',
                name: getName(r),
              })),
              date: msgDate,
              snippet: msg.snippet || '',
            };
          });
        } catch (e) {
          return [];
        }
      })()
    `,
    returnByValue: true,
  });

  return (result.result.value as ThreadMessage[]) || [];
}
