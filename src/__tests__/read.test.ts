import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  connectToSuperhuman,
  disconnect,
  type SuperhumanConnection,
} from "../superhuman-api";
import { listInbox } from "../inbox";
import { readThread, type ThreadMessage } from "../read";

const CDP_PORT = 9333;

describe("read", () => {
  let conn: SuperhumanConnection | null = null;
  let testThreadId: string | null = null;

  beforeAll(async () => {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error(
        "Could not connect to Superhuman. Make sure it is running with --remote-debugging-port=9333"
      );
    }

    // Get a thread ID to test with
    const threads = await listInbox(conn, { limit: 1 });
    if (threads.length > 0) {
      testThreadId = threads[0].id;
    }
  });

  afterAll(async () => {
    if (conn) {
      await disconnect(conn);
    }
  });

  test("readThread returns messages for a thread", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) throw new Error("No test thread available");

    const messages = await readThread(conn, testThreadId);

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);

    // Verify message structure
    const message = messages[0];
    expect(message).toHaveProperty("id");
    expect(message).toHaveProperty("from");
    expect(message).toHaveProperty("to");
    expect(message).toHaveProperty("date");
    expect(message).toHaveProperty("snippet");
    expect(message.from).toHaveProperty("email");
  });
});
