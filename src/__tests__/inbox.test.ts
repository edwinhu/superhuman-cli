import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  connectToSuperhuman,
  disconnect,
  type SuperhumanConnection,
} from "../superhuman-api";
import { listInbox, searchInbox, type InboxThread } from "../inbox";

const CDP_PORT = 9333;

describe("inbox", () => {
  let conn: SuperhumanConnection | null = null;

  beforeAll(async () => {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error(
        "Could not connect to Superhuman. Make sure it is running with --remote-debugging-port=9333"
      );
    }
  });

  afterAll(async () => {
    if (conn) {
      await disconnect(conn);
    }
  });

  test("listInbox returns threads", async () => {
    if (!conn) throw new Error("No connection");

    const threads = await listInbox(conn, { limit: 5 });

    expect(Array.isArray(threads)).toBe(true);
    expect(threads.length).toBeGreaterThan(0);
    expect(threads.length).toBeLessThanOrEqual(5);

    // Verify thread structure
    const thread = threads[0];
    expect(thread).toHaveProperty("id");
    expect(thread).toHaveProperty("subject");
    expect(thread).toHaveProperty("from");
    expect(thread).toHaveProperty("date");
    expect(thread).toHaveProperty("snippet");
  });

  test("listInbox respects limit option", async () => {
    if (!conn) throw new Error("No connection");

    const threads = await listInbox(conn, { limit: 2 });

    expect(threads.length).toBeLessThanOrEqual(2);
  });

  test("searchInbox returns matching threads", async () => {
    if (!conn) throw new Error("No connection");

    // Search for a common term that should return results
    const threads = await searchInbox(conn, { query: "from:me", limit: 5 });

    expect(Array.isArray(threads)).toBe(true);
    // Search may or may not return results, so just verify structure if results exist
    if (threads.length > 0) {
      const thread = threads[0];
      expect(thread).toHaveProperty("id");
      expect(thread).toHaveProperty("subject");
      expect(thread).toHaveProperty("from");
    }
  });
});
