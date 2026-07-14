/**
 * Quote-stripping helpers for inbox bodies.
 *
 * Superhuman's FTS body (`thread_search_content.c2content`) concatenates every
 * message in a thread oldest->newest, delimited by private-use characters
 * (U+F8F0–F8FF). The morning-briefing skill reads these bodies to decide
 * whether a thread needs a reply, but the full concatenation is misleading:
 * the HEAD is the oldest message and the TAIL message still carries its quoted
 * reply chain ("On <date> X wrote:", Outlook "From:/Sent:/To:/Subject:"
 * headers, ">"-prefixed lines). The clean `snippet` field is the right content
 * but is truncated to ~200 chars.
 *
 * `extractLatestMessage` isolates the newest message and strips its quoted
 * history, returning the full-length new content.
 */

// Private-use message-break delimiter range used by Superhuman's FTS index.
const MSG_BREAK = /[\u{F8F0}-\u{F8FF}]+/gu;

/**
 * Split a Superhuman FTS body into its per-message segments (oldest->newest),
 * trimmed and with empty segments removed (the body usually ends with a
 * trailing delimiter, producing an empty final segment).
 */
export function splitMessages(ftsBody: string): string[] {
  return ftsBody
    .split(MSG_BREAK)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Strip a quoted reply chain from a single message body, returning only the
 * new content written by the latest author.
 *
 * Cuts the body at the earliest of these quote-chain markers:
 *   - an "On <date> ... wrote:" attribution line (Gmail/Apple style)
 *   - an Outlook header block: a "From:" line closely followed by
 *     "Sent:"/"Date:"/"To:"/"Subject:"
 *   - a "-----Original Message-----" separator
 *   - the first ">"-prefixed quote line
 *
 * If no marker is found the input is returned trimmed (no quoted history).
 */
export function stripQuotedReply(text: string): string {
  if (!text) return "";
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  let cut = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    // "On <...> wrote:" — may wrap across up to 3 lines before "wrote:".
    if (/^On\b/.test(line)) {
      const joined = lines
        .slice(i, i + 3)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (/^On\b.*\bwrote:?\s*$/i.test(joined) || /^On\b.*\bwrote:/i.test(joined)) {
        cut = Math.min(cut, i);
        continue;
      }
    }

    // Outlook quoted-header block: "From:" followed within a few lines by
    // one of the other RFC-style headers.
    if (/^From:\s*\S/i.test(line)) {
      const lookahead = lines.slice(i + 1, i + 6).map((l) => l.trim());
      if (lookahead.some((l) => /^(Sent|Date|To|Subject|Cc):\s*\S/i.test(l))) {
        cut = Math.min(cut, i);
        continue;
      }
    }

    // Classic separators.
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) {
      cut = Math.min(cut, i);
      continue;
    }
    if (/^_{5,}\s*$/.test(line)) {
      // Outlook often precedes the "From:" header with a long underscore rule.
      const lookahead = lines.slice(i + 1, i + 4).map((l) => l.trim());
      if (lookahead.some((l) => /^From:\s*\S/i.test(l))) {
        cut = Math.min(cut, i);
        continue;
      }
    }

    // First ">"-prefixed quote line.
    if (/^>/.test(line)) {
      cut = Math.min(cut, i);
      continue;
    }
  }

  let result = lines.slice(0, cut).join("\n");

  // Drop a trailing "External Message"/"External Email" banner that sometimes
  // sits just above the quoted block.
  result = result.replace(/\n*\s*External (Message|Email)\s*$/i, "");

  // Collapse excessive blank lines and trim.
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Given a full Superhuman FTS body, return the newest message with its quoted
 * reply chain stripped. Returns "" when the body is empty.
 */
export function extractLatestMessage(ftsBody: string): string {
  const segments = splitMessages(ftsBody);
  if (segments.length === 0) return "";
  return stripQuotedReply(segments[segments.length - 1]!);
}
