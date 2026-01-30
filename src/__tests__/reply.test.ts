import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  connectToSuperhuman,
  disconnect,
  getDraftState,
  closeCompose,
  type SuperhumanConnection,
} from "../superhuman-api";
import { listInbox } from "../inbox";
import { readThread } from "../read";
import { replyToThread, replyAllToThread, forwardThread } from "../reply";
import { listAccounts } from "../accounts";

const CDP_PORT = 9333;

describe("reply", () => {
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
    if (threads.length > 0 && threads[0]) {
      testThreadId = threads[0].id;
    }
  });

  afterAll(async () => {
    if (conn) {
      // Clean up: close any open compose windows
      await closeCompose(conn);
      await disconnect(conn);
    }
  });

  test("test_reply_creates_draft_with_correct_recipients", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) throw new Error("No test thread available");

    // Get the original thread to know expected recipients
    const messages = await readThread(conn, testThreadId);
    expect(messages.length).toBeGreaterThan(0);

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error("No messages in thread");
    const originalSender = lastMessage.from.email;
    const originalSubject = lastMessage.subject;

    // Reply to the thread
    const replyBody = "This is a test reply message.";
    const result = await replyToThread(conn, testThreadId, replyBody, false);

    expect(result.success).toBe(true);

    // Verify draft state
    const draftState = await getDraftState(conn);
    expect(draftState).not.toBeNull();

    // To field should contain the original sender
    expect(draftState!.to).toContain(originalSender);

    // Subject should have "Re:" prefix (avoiding duplicate "Re: Re:")
    const expectedSubject = originalSubject.startsWith("Re:")
      ? originalSubject
      : `Re: ${originalSubject}`;
    expect(draftState!.subject).toBe(expectedSubject);

    // Body should include our reply text and a blockquote
    expect(draftState!.body).toContain(replyBody);
    expect(draftState!.body).toContain("<blockquote");
  });

  test("reply subject avoids duplicate Re: prefix", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) throw new Error("No test thread available");

    // Get thread messages
    const messages = await readThread(conn, testThreadId);
    expect(messages.length).toBeGreaterThan(0);

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error("No messages in thread");
    const originalSubject = lastMessage.subject;

    // Reply to the thread
    const result = await replyToThread(conn, testThreadId, "Test reply", false);
    expect(result.success).toBe(true);

    const draftState = await getDraftState(conn);
    expect(draftState).not.toBeNull();

    // Should not have "Re: Re:" pattern
    expect(draftState!.subject).not.toMatch(/^Re:\s*Re:/i);

    // Should have exactly one "Re:" prefix (if not already present)
    if (!originalSubject.startsWith("Re:")) {
      expect(draftState!.subject).toBe(`Re: ${originalSubject}`);
    } else {
      expect(draftState!.subject).toBe(originalSubject);
    }
  });

  test("reply body includes quoted original message", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) throw new Error("No test thread available");

    const messages = await readThread(conn, testThreadId);
    expect(messages.length).toBeGreaterThan(0);

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error("No messages in thread");

    const replyBody = "My reply content here.";
    const result = await replyToThread(conn, testThreadId, replyBody, false);
    expect(result.success).toBe(true);

    const draftState = await getDraftState(conn);
    expect(draftState).not.toBeNull();

    // Body should have the reply content
    expect(draftState!.body).toContain(replyBody);

    // Body should have a blockquote with attribution
    expect(draftState!.body).toContain("<blockquote");
    expect(draftState!.body).toContain("wrote:");

    // Blockquote should include original sender info
    const senderName = lastMessage.from.name || lastMessage.from.email;
    expect(draftState!.body).toContain(senderName);
  });

  test("test_reply_all_includes_all_recipients", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) throw new Error("No test thread available");

    // Get the original thread to know expected recipients
    const messages = await readThread(conn, testThreadId);
    expect(messages.length).toBeGreaterThan(0);

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error("No messages in thread");

    // Get current account to verify self is excluded from Cc
    const accounts = await listAccounts(conn);
    const currentAccount = accounts.find((a) => a.isCurrent);
    if (!currentAccount) throw new Error("No current account found");
    const currentEmail = currentAccount.email;

    // Reply-all to the thread
    const replyBody = "This is a test reply-all message.";
    const result = await replyAllToThread(conn, testThreadId, replyBody, false);

    expect(result.success).toBe(true);

    // Verify draft state
    const draftState = await getDraftState(conn);
    expect(draftState).not.toBeNull();

    // To field should contain the original sender
    expect(draftState!.to).toContain(lastMessage.from.email);

    // Subject should have "Re:" prefix
    const expectedSubject = lastMessage.subject.startsWith("Re:")
      ? lastMessage.subject
      : `Re: ${lastMessage.subject}`;
    expect(draftState!.subject).toBe(expectedSubject);

    // Body should include our reply text and a blockquote
    expect(draftState!.body).toContain(replyBody);
    expect(draftState!.body).toContain("<blockquote");

    // Self (current account) should NOT be in Cc
    expect(draftState!.cc).not.toContain(currentEmail);

    // Cc should contain other recipients from original To/Cc (excluding self and original sender)
    const expectedCcRecipients = [
      ...lastMessage.to.map((r) => r.email),
      ...lastMessage.cc.map((r) => r.email),
    ].filter(
      (email) =>
        email !== currentEmail && // Exclude self
        email !== lastMessage.from.email && // Exclude original sender (they're in To)
        email.length > 0 // Exclude empty emails
    );

    // Each expected Cc recipient should be in the draft Cc
    for (const expectedEmail of expectedCcRecipients) {
      expect(draftState!.cc).toContain(expectedEmail);
    }
  });

  test("test_forward_creates_draft_with_forward_header", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) throw new Error("No test thread available");

    // Get the original thread to know expected metadata
    const messages = await readThread(conn, testThreadId);
    expect(messages.length).toBeGreaterThan(0);

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error("No messages in thread");

    // Forward the thread
    const forwardBody = "Please see the forwarded message below.";
    const forwardToEmail = "forward-recipient@example.com";
    const result = await forwardThread(
      conn,
      testThreadId,
      forwardToEmail,
      forwardBody,
      false
    );

    expect(result.success).toBe(true);

    // Verify draft state
    const draftState = await getDraftState(conn);
    expect(draftState).not.toBeNull();

    // To field should contain the forward recipient
    expect(draftState!.to).toContain(forwardToEmail);

    // Subject should have "Fwd:" prefix
    const expectedSubject = lastMessage.subject.startsWith("Fwd:")
      ? lastMessage.subject
      : `Fwd: ${lastMessage.subject}`;
    expect(draftState!.subject).toBe(expectedSubject);

    // Body should include our forward text
    expect(draftState!.body).toContain(forwardBody);

    // Body should include forward header with metadata
    expect(draftState!.body).toContain("---------- Forwarded message ---------");
    expect(draftState!.body).toContain("From:");
    expect(draftState!.body).toContain("Date:");
    expect(draftState!.body).toContain("Subject:");
    expect(draftState!.body).toContain("To:");

    // Forward header should contain actual message metadata
    expect(draftState!.body).toContain(lastMessage.from.email);
    expect(draftState!.body).toContain(lastMessage.subject);
  });
});
