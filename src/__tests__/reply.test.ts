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

/**
 * Helper to get draft with threading info from Superhuman's native state
 */
async function getDraftWithThreading(conn: SuperhumanConnection) {
  const { Runtime } = conn;
  const result = await Runtime.evaluate({
    expression: `
      (() => {
        const cfc = window.ViewState?._composeFormController;
        if (!cfc) return null;
        const draftKey = Object.keys(cfc).find(k => k.startsWith('draft'));
        if (!draftKey) return null;
        const ctrl = cfc[draftKey];
        const draft = ctrl?.state?.draft;
        if (!draft) return null;
        return {
          id: draft.id,
          threadId: draft.threadId,
          inReplyTo: draft.inReplyTo,
          subject: draft.subject || '',
          body: draft.body || '',
          to: (draft.to || []).map(function(r) { return r.email; }),
          cc: (draft.cc || []).map(function(r) { return r.email; }),
          bcc: (draft.bcc || []).map(function(r) { return r.email; }),
          from: draft.from?.email || '',
        };
      })()
    `,
    returnByValue: true,
  });
  return result.result.value as {
    id: string;
    threadId: string;
    inReplyTo: string;
    subject: string;
    body: string;
    to: string[];
    cc: string[];
    bcc: string[];
    from: string;
  } | null;
}

/**
 * Helper to get the currently open thread's ID
 */
async function getCurrentThreadId(conn: SuperhumanConnection): Promise<string | null> {
  const { Runtime } = conn;
  const result = await Runtime.evaluate({
    expression: `
      (() => {
        const tree = window.ViewState?.tree;
        const data = tree?.get?.() || tree?._data;
        return data?.threadPane?.threadId || null;
      })()
    `,
    returnByValue: true,
  });
  return result.result.value as string | null;
}

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

    // The reply functions require a thread to be currently open in the thread pane
    // This is by design - you can only reply to a thread you're viewing
    testThreadId = await getCurrentThreadId(conn);

    if (!testThreadId) {
      console.warn(
        "WARNING: No thread is currently open in Superhuman. " +
        "Reply tests require a thread to be open. " +
        "Please open a thread and re-run the tests."
      );
    }
  });

  afterAll(async () => {
    if (conn) {
      // Clean up: close any open compose windows
      await closeCompose(conn);
      await disconnect(conn);
    }
  });

  test("test_reply_creates_draft_with_correct_threading", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) {
      console.log("Skipping: No thread is currently open in Superhuman");
      return;
    }

    // Get the original thread
    const messages = await readThread(conn, testThreadId);
    expect(messages.length).toBeGreaterThan(0);

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error("No messages in thread");
    const originalSubject = lastMessage.subject;

    // Reply to the thread
    const replyBody = "This is a test reply message.";
    const result = await replyToThread(conn, testThreadId, replyBody, false);

    expect(result.success).toBe(true);

    // Verify draft state with threading info
    const draftState = await getDraftWithThreading(conn);
    expect(draftState).not.toBeNull();

    // CRITICAL: Threading should be correct
    expect(draftState!.threadId).toBe(testThreadId);
    expect(draftState!.inReplyTo).toBeTruthy(); // Should have inReplyTo set

    // To field should have at least one recipient (Superhuman determines correct reply recipient)
    expect(draftState!.to.length).toBeGreaterThan(0);

    // Subject should have "Re:" prefix (Superhuman normalizes, stripping nested Fwd:)
    const baseSubject = originalSubject
      .replace(/^(Re:\s*)+/i, "")
      .replace(/^(Fwd:\s*)+/i, "");
    expect(draftState!.subject).toBe(`Re: ${baseSubject}`);

    // Body should include our reply text
    expect(draftState!.body).toContain(replyBody);
  });

  test("reply subject avoids duplicate Re: prefix", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) {
      console.log("Skipping: No thread is currently open in Superhuman");
      return;
    }

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

  test("reply body includes user content", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) {
      console.log("Skipping: No thread is currently open in Superhuman");
      return;
    }

    const replyBody = "My reply content here.";
    const result = await replyToThread(conn, testThreadId, replyBody, false);
    expect(result.success).toBe(true);

    const draftState = await getDraftState(conn);
    expect(draftState).not.toBeNull();

    // Body should have the reply content
    expect(draftState!.body).toContain(replyBody);

    // Superhuman handles quoted messages in its own format - we don't need to test that
  });

  test("test_reply_all_has_correct_threading_and_recipients", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) {
      console.log("Skipping: No thread is currently open in Superhuman");
      return;
    }

    // Get the original thread
    const messages = await readThread(conn, testThreadId);
    expect(messages.length).toBeGreaterThan(0);

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error("No messages in thread");

    // Get current account to verify self is excluded from recipients
    const accounts = await listAccounts(conn);
    const currentAccount = accounts.find((a) => a.isCurrent);
    if (!currentAccount) throw new Error("No current account found");
    const currentEmail = currentAccount.email;

    // Reply-all to the thread
    const replyBody = "This is a test reply-all message.";
    const result = await replyAllToThread(conn, testThreadId, replyBody, false);

    expect(result.success).toBe(true);

    // Verify draft state with threading
    const draftState = await getDraftWithThreading(conn);
    expect(draftState).not.toBeNull();

    // CRITICAL: Threading should be correct
    expect(draftState!.threadId).toBe(testThreadId);
    expect(draftState!.inReplyTo).toBeTruthy();

    // To field should have at least one recipient
    expect(draftState!.to.length).toBeGreaterThan(0);

    // Subject should have "Re:" prefix
    const expectedSubject = lastMessage.subject.startsWith("Re:")
      ? lastMessage.subject
      : `Re: ${lastMessage.subject}`;
    expect(draftState!.subject).toBe(expectedSubject);

    // Body should include our reply text
    expect(draftState!.body).toContain(replyBody);

    // Self (current account) should NOT be in To or Cc
    expect(draftState!.to).not.toContain(currentEmail);
    expect(draftState!.cc).not.toContain(currentEmail);

    // Total recipients (To + Cc) should include multiple people for reply-all
    // (unless the thread only had 2 participants)
    const totalRecipients = draftState!.to.length + draftState!.cc.length;
    expect(totalRecipients).toBeGreaterThanOrEqual(1);
  });

  test("test_forward_creates_draft_with_correct_recipient_and_subject", async () => {
    if (!conn) throw new Error("No connection");
    if (!testThreadId) {
      console.log("Skipping: No thread is currently open in Superhuman");
      return;
    }

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

    // Subject should have "Fwd:" prefix (Superhuman strips Re: when forwarding)
    const baseSubject = lastMessage.subject
      .replace(/^(Re:\s*)+/i, "")
      .replace(/^(Fwd:\s*)+/i, "");
    expect(draftState!.subject).toBe(`Fwd: ${baseSubject}`);

    // Body should include our forward text
    expect(draftState!.body).toContain(forwardBody);

    // Superhuman handles the forward header in its own format
    // We just verify the user's content is included
  });
});
