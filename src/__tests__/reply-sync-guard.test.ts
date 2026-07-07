/**
 * Tests for the reply send-delivery guard's pure predicate.
 *
 * A reply needs the thread's REAL per-message provider ids in
 * `current_message_ids`. When the thread isn't synced to the local Superhuman
 * SQLite cache and we fall back to MS Graph (which yields only the conversation
 * id), those ids are unavailable — the backend accepts the send (HTTP 200) then
 * silently drops it. `usableReplyMessageIds` / `isReplyDeliverable` encode exactly
 * which thread states are deliverable. These are pure (no I/O, no process.exit).
 */

import { test, expect, describe } from "bun:test";
import { usableReplyMessageIds, isReplyDeliverable } from "../cli";

const THREAD = "AAQkAGconversationID==";

describe("usableReplyMessageIds", () => {
  test("real per-message ids → returned as-is (deliverable)", () => {
    const info = { messageIds: ["AAkALmsg1==", "AAkALmsg2=="] };
    expect(usableReplyMessageIds(info, THREAD)).toEqual(["AAkALmsg1==", "AAkALmsg2=="]);
    expect(isReplyDeliverable(info, THREAD)).toBe(true);
  });

  test("single id equal to the conversation id → [] (MS-Graph fallback, NOT deliverable)", () => {
    const info = { messageIds: [THREAD] };
    expect(usableReplyMessageIds(info, THREAD)).toEqual([]);
    expect(isReplyDeliverable(info, THREAD)).toBe(false);
  });

  test("single id equal to the thread id WITH idsVerified → deliverable (single-message Gmail thread)", () => {
    // Gmail: a one-message thread's real message id equals the thread id. When the
    // ids were read from real per-message records (SQLite cache / backend RPC),
    // that's a genuine deliverable reply, not the conversation-id fallback.
    const gmailThread = "19f3c38fd957a3e1";
    const info = { messageIds: [gmailThread], idsVerified: true };
    expect(usableReplyMessageIds(info, gmailThread)).toEqual([gmailThread]);
    expect(isReplyDeliverable(info, gmailThread)).toBe(true);
  });

  test("empty messageIds → [] (unsynced thread, NOT deliverable)", () => {
    expect(usableReplyMessageIds({ messageIds: [] }, THREAD)).toEqual([]);
    expect(isReplyDeliverable({ messageIds: [] }, THREAD)).toBe(false);
  });

  test("missing messageIds field (MS Graph threadInfo) → [] (NOT deliverable)", () => {
    const graphInfo = { subject: "Re: x", from: "a@b.com", to: [], cc: [] };
    expect(usableReplyMessageIds(graphInfo, THREAD)).toEqual([]);
    expect(isReplyDeliverable(graphInfo, THREAD)).toBe(false);
  });

  test("null / undefined threadInfo → [] (NOT deliverable)", () => {
    expect(usableReplyMessageIds(null, THREAD)).toEqual([]);
    expect(usableReplyMessageIds(undefined, THREAD)).toEqual([]);
    expect(isReplyDeliverable(null, THREAD)).toBe(false);
  });

  test("falsy/blank ids are filtered before the deliverability check", () => {
    expect(usableReplyMessageIds({ messageIds: ["", null, undefined] as any }, THREAD)).toEqual([]);
    expect(isReplyDeliverable({ messageIds: ["", null, undefined] as any }, THREAD)).toBe(false);
  });

  test("a single REAL id distinct from the conversation id IS deliverable", () => {
    // Single-message thread: one real provider id that isn't the conversation id.
    const info = { messageIds: ["AAkALonlyMsg=="] };
    expect(usableReplyMessageIds(info, THREAD)).toEqual(["AAkALonlyMsg=="]);
    expect(isReplyDeliverable(info, THREAD)).toBe(true);
  });
});
