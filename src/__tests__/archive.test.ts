import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  connectToSuperhuman,
  disconnect,
  type SuperhumanConnection,
} from "../superhuman-api";
import { listInbox } from "../inbox";
import { archiveThread, deleteThread } from "../archive";

const CDP_PORT = 9333;

describe("archive", () => {
  let conn: SuperhumanConnection | null = null;
  let testThreadId: string | null = null;

  beforeAll(async () => {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error(
        "Could not connect to Superhuman. Make sure it is running with --remote-debugging-port=9333"
      );
    }

    // Get a thread ID to test with - must be an actual inbox thread (not a draft)
    const threads = await listInbox(conn, { limit: 20 });
    // Find a thread that has INBOX label (real inbox thread, not draft)
    const inboxThread = threads.find((t) => t.labelIds.includes("INBOX"));
    if (inboxThread) {
      testThreadId = inboxThread.id;
    }
  });

  afterAll(async () => {
    if (conn) {
      await disconnect(conn);
    }
  });

  test("archiveThread removes thread from inbox", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) throw new Error("No test thread available");

    // Get inbox before archive
    const inboxBefore = await listInbox(conn, { limit: 50 });
    const threadInInboxBefore = inboxBefore.some((t) => t.id === testThreadId);
    expect(threadInInboxBefore).toBe(true);

    // Archive the thread
    const result = await archiveThread(conn, testThreadId);
    expect(result.success).toBe(true);

    // Wait a moment for the UI to update
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Get inbox after archive
    const inboxAfter = await listInbox(conn, { limit: 50 });
    const threadInInboxAfter = inboxAfter.some((t) => t.id === testThreadId);

    // Thread should NOT be in inbox after archiving
    expect(threadInInboxAfter).toBe(false);
  });

  test("deleteThread moves thread to trash", async () => {
    if (!conn) throw new Error("No connection");

    // Get a fresh thread from inbox
    const threads = await listInbox(conn, { limit: 20 });
    const inboxThread = threads.find((t) => t.labelIds.includes("INBOX"));
    if (!inboxThread) throw new Error("No inbox thread available for delete test");

    const deleteThreadId = inboxThread.id;

    // Delete (trash) the thread
    const result = await deleteThread(conn, deleteThreadId);
    expect(result.success).toBe(true);

    // Wait a moment for the UI to update
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Get inbox after delete
    const inboxAfter = await listInbox(conn, { limit: 50 });
    const threadInInboxAfter = inboxAfter.some((t) => t.id === deleteThreadId);

    // Thread should NOT be in inbox after deleting (moved to trash)
    expect(threadInInboxAfter).toBe(false);
  });

  test("archiveThread handles multiple threads (bulk operation)", async () => {
    if (!conn) throw new Error("No connection");

    // Get fresh threads from inbox for bulk archive
    const threads = await listInbox(conn, { limit: 20 });
    const inboxThreads = threads.filter((t) => t.labelIds.includes("INBOX"));

    if (inboxThreads.length < 3) {
      throw new Error("Not enough inbox threads available for bulk archive test (need at least 3)");
    }

    // Take 3 threads to archive
    const threadsToArchive = inboxThreads.slice(0, 3);
    const threadIds = threadsToArchive.map((t) => t.id);

    // Verify all threads are in inbox before archiving
    const inboxBefore = await listInbox(conn, { limit: 50 });
    for (const threadId of threadIds) {
      const isInInbox = inboxBefore.some((t) => t.id === threadId);
      expect(isInInbox).toBe(true);
    }

    // Archive each thread
    for (const threadId of threadIds) {
      const result = await archiveThread(conn, threadId);
      expect(result.success).toBe(true);
      // Small delay between operations
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Wait for UI to update
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify all threads are removed from inbox
    const inboxAfter = await listInbox(conn, { limit: 50 });
    for (const threadId of threadIds) {
      const isInInbox = inboxAfter.some((t) => t.id === threadId);
      expect(isInInbox).toBe(false);
    }
  });

  test("deleteThread handles multiple threads (bulk operation)", async () => {
    if (!conn) throw new Error("No connection");

    // Get fresh threads from inbox for bulk delete
    const threads = await listInbox(conn, { limit: 20 });
    const inboxThreads = threads.filter((t) => t.labelIds.includes("INBOX"));

    if (inboxThreads.length < 3) {
      throw new Error("Not enough inbox threads available for bulk delete test (need at least 3)");
    }

    // Take 3 threads to delete
    const threadsToDelete = inboxThreads.slice(0, 3);
    const threadIds = threadsToDelete.map((t) => t.id);

    // Verify all threads are in inbox before deleting
    const inboxBefore = await listInbox(conn, { limit: 50 });
    for (const threadId of threadIds) {
      const isInInbox = inboxBefore.some((t) => t.id === threadId);
      expect(isInInbox).toBe(true);
    }

    // Delete each thread
    for (const threadId of threadIds) {
      const result = await deleteThread(conn, threadId);
      expect(result.success).toBe(true);
      // Small delay between operations
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Wait for UI to update
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify all threads are removed from inbox (moved to trash)
    const inboxAfter = await listInbox(conn, { limit: 50 });
    for (const threadId of threadIds) {
      const isInInbox = inboxAfter.some((t) => t.id === threadId);
      expect(isInInbox).toBe(false);
    }
  });
});
