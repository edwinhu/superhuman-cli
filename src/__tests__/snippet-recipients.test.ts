// src/__tests__/snippet-recipients.test.ts
// Regression test: snippet use should pass BCC/CC/To recipients to the created draft
// Bug: when Superhuman API returns recipients as {email, name} objects, they were
//      passed directly to userdata.writeMessage which expects string format ("Name <email>"),
//      causing the backend to silently drop the recipient fields.

import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { listSnippets } from "../snippets";
import type { UserInfo } from "../draft-api";

const FAKE_USER_INFO: UserInfo = {
  userId: "user123",
  email: "test@example.com",
  token: "fake-token",
  timeZone: "America/New_York",
};

/**
 * Build a fake userdata.getThreads response with a snippet that has BCC recipients
 * stored as {email, name} objects (the format Superhuman app writes them).
 */
function makeSnippetResponseWithObjectRecipients() {
  return {
    threadList: [
      {
        thread: {
          messages: {
            "draft001": {
              draft: {
                id: "draft001",
                threadId: "thread001",
                action: "snippet",
                name: "Securities Regulation Spring 25",
                body: "<p>Hello class</p>",
                subject: "Class Announcement",
                snippet: "Hello class",
                to: [],
                cc: [],
                // BCC stored as objects (Superhuman app format)
                bcc: [
                  { email: "student1@example.com", name: "Student One" },
                  { email: "student2@example.com", name: "Student Two" },
                  { email: "student3@example.com", name: "Student Three" },
                ],
              },
              snippetAnalytics: { sends: 5, lastSentAt: "2026-01-01" },
            },
          },
        },
      },
    ],
  };
}

/**
 * Build a fake userdata.getThreads response with a snippet that has BCC recipients
 * stored as strings (the normalized string format).
 */
function makeSnippetResponseWithStringRecipients() {
  return {
    threadList: [
      {
        thread: {
          messages: {
            "draft002": {
              draft: {
                id: "draft002",
                threadId: "thread002",
                action: "snippet",
                name: "Test Snippet",
                body: "<p>Test body</p>",
                subject: "Test",
                snippet: "Test body",
                to: ["recipient@example.com"],
                cc: [],
                bcc: [
                  "Student One <student1@example.com>",
                  "Student Two <student2@example.com>",
                ],
              },
              snippetAnalytics: { sends: 2, lastSentAt: null },
            },
          },
        },
      },
    ],
  };
}

describe("snippet recipient handling", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("listSnippets returns BCC as string[] when API returns object recipients", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify(makeSnippetResponseWithObjectRecipients()),
        { status: 200 }
      );
    }) as any;

    const snippets = await listSnippets(FAKE_USER_INFO);
    expect(snippets).toHaveLength(1);

    const snippet = snippets[0]!;
    expect(snippet.name).toBe("Securities Regulation Spring 25");
    expect(snippet.bcc).toHaveLength(3);

    // CRITICAL: BCC entries must be strings (not objects) for correct draft creation
    // If the API returns {email, name} objects, listSnippets must normalize them to strings
    for (const bccEntry of snippet.bcc) {
      expect(typeof bccEntry).toBe("string");
    }

    // The string format should be "Name <email>" or just "email"
    expect(snippet.bcc[0]).toContain("student1@example.com");
  });

  test("listSnippets returns string BCC unchanged when API returns string recipients", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify(makeSnippetResponseWithStringRecipients()),
        { status: 200 }
      );
    }) as any;

    const snippets = await listSnippets(FAKE_USER_INFO);
    expect(snippets).toHaveLength(1);

    const snippet = snippets[0]!;
    expect(snippet.bcc).toHaveLength(2);
    expect(snippet.bcc[0]).toBe("Student One <student1@example.com>");
    expect(snippet.bcc[1]).toBe("Student Two <student2@example.com>");
    expect(snippet.to[0]).toBe("recipient@example.com");
  });

  test("snippet with object recipients: draft creation payload has string BCC", async () => {
    globalThis.fetch = mock(async (url: string, _opts: RequestInit) => {
      if ((url as string).includes("userdata.getThreads")) {
        return new Response(
          JSON.stringify(makeSnippetResponseWithObjectRecipients()),
          { status: 200 }
        );
      }
      // Capture draft creation payload
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    const snippets = await listSnippets(FAKE_USER_INFO);
    const snippet = snippets[0]!;

    // Simulate the merge logic from cmdSnippet
    const bcc =
      snippet.bcc.length > 0 ? snippet.bcc : undefined;

    // Pass to createDraftWithUserInfo — capture what gets written
    let capturedBcc: any = null;
    globalThis.fetch = mock(async (_url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string);
      const draftValue = body.writes?.[0]?.value;
      if (draftValue) {
        capturedBcc = draftValue.bcc;
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as any;

    const { createDraftWithUserInfo } = await import("../draft-api");
    await createDraftWithUserInfo(FAKE_USER_INFO, {
      to: [],
      bcc,
      subject: "Test",
      body: "<p>Test</p>",
    });

    // BCC must be an array of strings, not objects
    expect(Array.isArray(capturedBcc)).toBe(true);
    expect(capturedBcc.length).toBe(3);
    for (const entry of capturedBcc) {
      expect(typeof entry).toBe("string");
    }
    expect(capturedBcc[0]).toContain("student1@example.com");
  });
});
