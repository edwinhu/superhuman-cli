#!/usr/bin/env bun
/**
 * Probe: print the quote-stripped latest message for given thread ids, using
 * the exact production code path (getThreadBodiesFromDB + extractLatestMessage).
 *
 * Usage:
 *   bun scripts/latest-message-probe.ts <accountEmail> <threadId> [<threadId>...]
 *     -> NDJSON: {id, latestMessage} per thread, from the live SQLite cache.
 *   bun scripts/latest-message-probe.ts --raw    (raw FTS body on stdin)
 *     -> prints extractLatestMessage(stdin) verbatim. No DB; for synthetic tests.
 *
 * Used by the pytest suite (tests/test_latest_message.py) so the test exercises
 * the real extraction against both live data and crafted bodies.
 */
import { getThreadBodiesFromDB } from "../src/sqlite-search";
import { extractLatestMessage } from "../src/quote-strip";

if (process.argv[2] === "--raw") {
  const raw = await Bun.stdin.text();
  process.stdout.write(extractLatestMessage(raw));
  process.exit(0);
}

const [email, ...ids] = process.argv.slice(2);
if (!email || ids.length === 0) {
  console.error("usage: latest-message-probe.ts <accountEmail> <threadId>...");
  process.exit(2);
}

const bodies = getThreadBodiesFromDB(email, ids);
for (const id of ids) {
  const raw = bodies.get(id) ?? "";
  console.log(JSON.stringify({ id, latestMessage: extractLatestMessage(raw) }));
}
