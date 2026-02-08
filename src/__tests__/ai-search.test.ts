// src/__tests__/ai-search.test.ts
// Unit tests for AI search (askAISearch) using the askAIProxy endpoint
import { test, expect, describe, afterEach, mock } from "bun:test";
import { askAISearch, type TokenInfo } from "../token-api";

describe("askAISearch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createMockFetch(response: {
    ok: boolean;
    status?: number;
    text?: string;
  }) {
    const mockFn = mock(() =>
      Promise.resolve({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        text: () => Promise.resolve(response.text ?? ""),
        json: () => Promise.resolve({}),
      } as Response)
    );
    globalThis.fetch = mockFn as unknown as typeof fetch;
    return mockFn;
  }

  // A minimal JWT with sub claim (base64url encoded)
  const fakeIdToken = [
    btoa(JSON.stringify({ alg: "RS256" })).replace(/=/g, ""),
    btoa(JSON.stringify({ sub: "12345678", email: "test@example.com" })).replace(/=/g, ""),
    "fake_signature",
  ].join(".");

  const fakeOauthToken: TokenInfo = {
    accessToken: "fake_access_token",
    email: "test@example.com",
    expires: Date.now() + 3600000,
    isMicrosoft: false,
    idToken: fakeIdToken,
  };

  test("calls ai.askAIProxy endpoint with correct payload structure", async () => {
    // SSE response mimicking Superhuman's askAIProxy format
    const sseResponse = [
      `data: {"event_id":"evt1","content":"<thinking>\\nLet me search.\\n</thinking>","active_agent":"orchestrator"}`,
      `data: {"event_id":"evt2","content":"<thinking>\\nLet me search.\\n</thinking>\\n\\nI found the email you're looking for.","active_agent":"orchestrator"}`,
      `data: [DONE]`,
    ].join("\n");

    const mockFetch = createMockFetch({ ok: true, text: sseResponse });

    const result = await askAISearch(
      fakeIdToken,
      fakeOauthToken,
      "find the email about Stanford",
    );

    // Verify fetch was called
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify URL
    const [url, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://mail.superhuman.com/~backend/v3/ai.askAIProxy");
    expect(options.method).toBe("POST");

    // Verify payload
    const body = JSON.parse(options.body as string);
    expect(body.query).toBe("find the email about Stanford");
    expect(body.session_id).toBeTruthy();
    expect(body.question_event_id).toMatch(/^event_/);
    expect(body.user.provider_id).toBe("12345678");
    expect(body.user.email).toBe("test@example.com");
    expect(body.available_skills).toContain("filter");
    expect(body.chat_history).toEqual([]);

    // Verify response (thinking tags stripped)
    expect(result.response).toBe("I found the email you're looking for.");
    expect(result.sessionId).toBeTruthy();
  });

  test("strips <thinking> tags from response", async () => {
    const sseResponse = [
      `data: {"event_id":"evt1","content":"<thinking>\\nReflecting on the query.\\n</thinking>\\n\\nHere is the answer.","active_agent":"orchestrator"}`,
    ].join("\n");

    createMockFetch({ ok: true, text: sseResponse });

    const result = await askAISearch(fakeIdToken, fakeOauthToken, "test query");
    expect(result.response).toBe("Here is the answer.");
    expect(result.response).not.toContain("<thinking>");
  });

  test("includes thread context when threadId is provided", async () => {
    // Mock two fetches: first for getThreadMessages (Gmail), second for askAIProxy
    let callCount = 0;
    const mockFn = mock(() => {
      callCount++;
      if (callCount === 1) {
        // Gmail thread fetch
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              messages: [
                {
                  id: "msg1",
                  threadId: "thread1",
                  payload: {
                    headers: [
                      { name: "Subject", value: "Test Subject" },
                      { name: "From", value: "sender@example.com" },
                      { name: "To", value: "test@example.com" },
                      { name: "Date", value: "2026-01-01T00:00:00Z" },
                    ],
                    mimeType: "text/plain",
                    body: { data: btoa("Hello world") },
                  },
                  snippet: "Hello world",
                },
              ],
            }),
          text: () => Promise.resolve(""),
        } as Response);
      }
      // askAIProxy SSE
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            `data: {"event_id":"evt1","content":"Thread summary here.","active_agent":"orchestrator"}\ndata: [DONE]`
          ),
        json: () => Promise.resolve({}),
      } as Response);
    });
    globalThis.fetch = mockFn as unknown as typeof fetch;

    const result = await askAISearch(fakeIdToken, fakeOauthToken, "summarize this", {
      threadId: "thread1",
    });

    expect(result.response).toBe("Thread summary here.");
    // Should have called fetch at least twice (Gmail API + askAIProxy)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test("handles authentication errors", async () => {
    createMockFetch({ ok: false, status: 401, text: "Unauthorized" });

    await expect(
      askAISearch(fakeIdToken, fakeOauthToken, "test query")
    ).rejects.toThrow("authentication error");
  });

  test("handles server errors", async () => {
    createMockFetch({ ok: false, status: 500, text: "Internal Server Error" });

    await expect(
      askAISearch(fakeIdToken, fakeOauthToken, "test query")
    ).rejects.toThrow("AI query failed");
  });

  test("passes chat history when provided", async () => {
    const sseResponse = `data: {"event_id":"evt1","content":"Follow-up answer.","active_agent":"orchestrator"}\ndata: [DONE]`;
    const mockFetch = createMockFetch({ ok: true, text: sseResponse });

    await askAISearch(fakeIdToken, fakeOauthToken, "tell me more", {
      chatHistory: [
        { role: "user", content: "find emails about project" },
        { role: "assistant", content: "I found 3 emails." },
      ],
    });

    const [, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.chat_history).toHaveLength(2);
    expect(body.chat_history[0].role).toBe("user");
    expect(body.chat_history[1].role).toBe("assistant");
  });
});
