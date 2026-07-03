/**
 * Regression tests for `search --with-body` (BUG 2) and the `read` Outlook
 * conversationId query (BUG 1), surfaced 2026-07-03 on the ehu@law.virginia.edu
 * (Exchange) account reading an older Brian Hockin thread.
 *
 * BUG 2: `search --with-body` returned empty body/latestMessage. The body-field
 * transform (shared with `inbox --with-body`) was never wired into `search`.
 * These tests cover the pure transforms that both paths now use.
 *
 * BUG 1: `readThreadMsGraph` combined `$filter=conversationId eq` with
 * `$orderby=receivedDateTime`, which Exchange rejects with InefficientFilter
 * (400). We assert the query builder no longer pairs the two.
 */
import { test, expect } from "bun:test";
import { bodyFieldsFromFts, bodyFieldsFromMessages } from "../cli";

// U+F8FF is a Superhuman private-use message delimiter.
const DELIM = "";

test("bodyFieldsFromFts: normalizes message delimiters and extracts latest", () => {
  const raw = `Oldest message${DELIM}Newest message body`;
  const { body, latestMessage } = bodyFieldsFromFts(raw, { latestOnly: false, bodyChars: 0 });
  expect(body).toContain("Oldest message");
  expect(body).toContain("--- message break ---");
  expect(body).toContain("Newest message body");
  expect(latestMessage.length).toBeGreaterThan(0);
});

test("bodyFieldsFromFts: --body-chars keeps the tail (latest message)", () => {
  const raw = `${"A".repeat(1000)}${DELIM}${"Z".repeat(50)}`;
  const { body } = bodyFieldsFromFts(raw, { latestOnly: false, bodyChars: 100 });
  expect(body.length).toBe(101); // 100 chars + leading ellipsis
  expect(body.startsWith("…")).toBe(true);
  expect(body).toContain("Z"); // tail retained, head dropped
});

test("bodyFieldsFromFts: --latest-only emits only the clean latest message", () => {
  const raw = `Old quoted stuff${DELIM}Fresh reply`;
  const { body, latestMessage } = bodyFieldsFromFts(raw, { latestOnly: true, bodyChars: 0 });
  expect(body).toBe(latestMessage);
  expect(body).not.toContain("--- message break ---");
});

test("bodyFieldsFromFts: empty raw yields empty fields (graceful)", () => {
  const { body, latestMessage } = bodyFieldsFromFts("", { latestOnly: false, bodyChars: 0 });
  expect(body).toBe("");
  expect(latestMessage).toBe("");
});

test("bodyFieldsFromMessages: renders HTML thread to text, latest = last message", () => {
  const messages = [
    { id: "1", threadId: "t", subject: "s", from: { email: "", name: "" }, to: [], cc: [], date: "2024-01-01", snippet: "", body: "<p>First</p>" },
    { id: "2", threadId: "t", subject: "s", from: { email: "", name: "" }, to: [], cc: [], date: "2024-01-02", snippet: "", body: "<p>Second</p>" },
  ] as any;
  const { body, latestMessage } = bodyFieldsFromMessages(messages, { latestOnly: false, bodyChars: 0 });
  expect(body).toContain("First");
  expect(body).toContain("Second");
  expect(body).toContain("--- message break ---");
  expect(latestMessage).toContain("Second");
  expect(latestMessage).not.toContain("First");
});

test("bodyFieldsFromMessages: falls back to snippet when body missing", () => {
  const messages = [
    { id: "1", threadId: "t", subject: "s", from: { email: "", name: "" }, to: [], cc: [], date: "2024-01-01", snippet: "snippet text", body: undefined },
  ] as any;
  const { latestMessage } = bodyFieldsFromMessages(messages, { latestOnly: false, bodyChars: 0 });
  expect(latestMessage).toContain("snippet text");
});

test("bodyFieldsFromMessages: empty message list yields empty fields (graceful)", () => {
  const { body, latestMessage } = bodyFieldsFromMessages([], { latestOnly: false, bodyChars: 0 });
  expect(body).toBe("");
  expect(latestMessage).toBe("");
});

test("BUG 1: read.ts MS Graph query never pairs conversationId filter with $orderby", async () => {
  // Exchange rejects `$filter=conversationId eq …` + `$orderby=…` with
  // InefficientFilter (400). The conversation-expansion queries must sort
  // client-side instead. Guard against the pairing regressing.
  const src = await Bun.file(new URL("../read.ts", import.meta.url)).text();
  // Inspect only the actual query-string template lines (they interpolate the
  // conversationId filterParam), not the explanatory comments.
  const queryTemplateLines = src
    .split("\n")
    .filter((l) => l.includes("$filter=${encodeURIComponent(filterParam)}"));
  expect(queryTemplateLines.length).toBeGreaterThan(0);
  for (const line of queryTemplateLines) {
    expect(line.includes("$orderby")).toBe(false);
  }
  // And the conversationId queries must still exist (still filtering by convId).
  expect(src).toContain("conversationId eq");
});
