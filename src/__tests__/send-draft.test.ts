// src/__tests__/send-draft.test.ts
import { test, expect, describe, afterEach, mock } from "bun:test";
import {
  sendDraftSuperhuman,
  getUserInfoFromCache,
  type SendDraftOptions,
} from "../draft-api";

describe("sendDraftSuperhuman", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    // Restore original fetch after each test
    globalThis.fetch = originalFetch;
  });

  /**
   * Helper to create a mock fetch function
   */
  function createMockFetch(response: { ok: boolean; status?: number; data?: unknown; text?: string }) {
    const mockFn = mock(() =>
      Promise.resolve({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: () => Promise.resolve(response.data ?? {}),
        text: () => Promise.resolve(response.text ?? ""),
      } as Response)
    );
    // Cast to any to bypass Bun's fetch type requiring preconnect
    globalThis.fetch = mockFn as unknown as typeof fetch;
    return mockFn;
  }

  /**
   * Helper to get the messages/send call (skipping the logSend call).
   * sendDraftSuperhuman calls logSend first, then messages/send.
   */
  function getSendCall(mockFn: ReturnType<typeof createMockFetch>): [string, RequestInit] {
    const calls = mockFn.mock.calls;
    // Find the messages/send call (not /log)
    const sendCall = calls.find(
      (c) => {
        const url = (c as unknown as [string, RequestInit])[0];
        return url.includes("messages/send") && !url.includes("/log");
      }
    );
    return sendCall as unknown as [string, RequestInit];
  }

  test("sends to correct endpoint with proper payload structure", async () => {
    // Arrange
    const mockSendAt = 1770276316728;
    const mockFetch = createMockFetch({ ok: true, data: { send_at: mockSendAt } });

    const userInfo = getUserInfoFromCache(
      "user123",
      "sender@example.com",
      "token123",
      "Test User"
    );

    const options: SendDraftOptions = {
      draftId: "draft00abcdef123456",
      threadId: "draft00abcdef123456",
      to: [{ email: "recipient@example.com", name: "Recipient Name" }],
      subject: "Test Subject",
      htmlBody: "<p>Test body</p>",
    };

    // Act
    const result = await sendDraftSuperhuman(userInfo, options);

    // Assert
    expect(result.success).toBe(true);
    expect(result.sendAt).toBe(mockSendAt);

    // 2 calls: logSend + messages/send
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify send endpoint
    const [url, fetchOptions] = getSendCall(mockFetch);
    expect(url).toBe("https://mail.superhuman.com/~backend/messages/send");
    expect(fetchOptions.method).toBe("POST");
    expect(fetchOptions.headers).toHaveProperty("Authorization", "Bearer token123");
  });

  test("includes correct outgoing_message structure", async () => {
    // Arrange
    const mockFetch = createMockFetch({ ok: true, data: { send_at: 1234567890 } });

    const userInfo = getUserInfoFromCache(
      "user123",
      "sender@example.com",
      "token123",
      "Test User"
    );

    const options: SendDraftOptions = {
      draftId: "draft00abcdef123456",
      threadId: "draft00abcdef123456",
      to: [
        { email: "recipient1@example.com", name: "Recipient One" },
        { email: "recipient2@example.com" },
      ],
      cc: [{ email: "cc@example.com", name: "CC Person" }],
      bcc: [{ email: "bcc@example.com" }],
      subject: "Test Subject",
      htmlBody: "<p>Test body</p>",
    };

    // Act
    await sendDraftSuperhuman(userInfo, options);

    // Assert
    const [, fetchOptions] = getSendCall(mockFetch);
    const body = JSON.parse(fetchOptions.body as string);

    expect(body.version).toBe(3);
    expect(body.outgoing_message).toBeDefined();
    // from/to/cc/bcc use object format {email, name} (not string format)
    expect(body.outgoing_message.from).toEqual({ email: "sender@example.com", name: "Test User" });
    expect(body.outgoing_message.to).toHaveLength(2);
    expect(body.outgoing_message.to[0]).toEqual({ email: "recipient1@example.com", name: "Recipient One" });
    expect(body.outgoing_message.to[1]).toEqual({ email: "recipient2@example.com" });
    expect(body.outgoing_message.cc).toHaveLength(1);
    expect(body.outgoing_message.cc[0]).toEqual({ email: "cc@example.com", name: "CC Person" });
    expect(body.outgoing_message.bcc).toHaveLength(1);
    expect(body.outgoing_message.bcc[0]).toEqual({ email: "bcc@example.com" });
    expect(body.outgoing_message.subject).toBe("Test Subject");
    expect(body.outgoing_message.html_body).toBe("<p>Test body</p>");
    expect(body.outgoing_message.thread_id).toBe("draft00abcdef123456");
    expect(body.outgoing_message.message_id).toBe("draft00abcdef123456");
  });

  test("uses default delay of 20 seconds when not specified", async () => {
    // Arrange
    const mockFetch = createMockFetch({ ok: true, data: { send_at: 1234567890 } });

    const userInfo = getUserInfoFromCache("user123", "sender@example.com", "token123");

    const options: SendDraftOptions = {
      draftId: "draft00abcdef123456",
      threadId: "draft00abcdef123456",
      to: [{ email: "recipient@example.com" }],
      subject: "Test",
      htmlBody: "<p>Body</p>",
    };

    // Act
    await sendDraftSuperhuman(userInfo, options);

    // Assert
    const [, fetchOptions] = getSendCall(mockFetch);
    const body = JSON.parse(fetchOptions.body as string);
    expect(body.delay).toBe(20);
  });

  test("respects custom delay parameter", async () => {
    // Arrange
    const mockFetch = createMockFetch({ ok: true, data: { send_at: 1234567890 } });

    const userInfo = getUserInfoFromCache("user123", "sender@example.com", "token123");

    const options: SendDraftOptions = {
      draftId: "draft00abcdef123456",
      threadId: "draft00abcdef123456",
      to: [{ email: "recipient@example.com" }],
      subject: "Test",
      htmlBody: "<p>Body</p>",
      delay: 3600, // 1 hour delay
    };

    // Act
    await sendDraftSuperhuman(userInfo, options);

    // Assert
    const [, fetchOptions] = getSendCall(mockFetch);
    const body = JSON.parse(fetchOptions.body as string);
    expect(body.delay).toBe(3600);
  });

  test("supports immediate send with delay=0", async () => {
    // Arrange
    const mockFetch = createMockFetch({ ok: true, data: { send_at: 1234567890 } });

    const userInfo = getUserInfoFromCache("user123", "sender@example.com", "token123");

    const options: SendDraftOptions = {
      draftId: "draft00abcdef123456",
      threadId: "draft00abcdef123456",
      to: [{ email: "recipient@example.com" }],
      subject: "Test",
      htmlBody: "<p>Body</p>",
      delay: 0, // Immediate send
    };

    // Act
    await sendDraftSuperhuman(userInfo, options);

    // Assert
    const [, fetchOptions] = getSendCall(mockFetch);
    const body = JSON.parse(fetchOptions.body as string);
    expect(body.delay).toBe(0);
  });

  test("returns error on API failure", async () => {
    // Arrange
    createMockFetch({ ok: false, status: 401, text: "Unauthorized" });

    const userInfo = getUserInfoFromCache("user123", "sender@example.com", "token123");

    const options: SendDraftOptions = {
      draftId: "draft00abcdef123456",
      threadId: "draft00abcdef123456",
      to: [{ email: "recipient@example.com" }],
      subject: "Test",
      htmlBody: "<p>Body</p>",
    };

    // Act
    const result = await sendDraftSuperhuman(userInfo, options);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error).toContain("401");
  });

  test("handles network errors gracefully", async () => {
    // Arrange - mock fetch to throw network error
    const mockFn = mock(() => Promise.reject(new Error("Network error")));
    globalThis.fetch = mockFn as unknown as typeof fetch;

    const userInfo = getUserInfoFromCache("user123", "sender@example.com", "token123");

    const options: SendDraftOptions = {
      draftId: "draft00abcdef123456",
      threadId: "draft00abcdef123456",
      to: [{ email: "recipient@example.com" }],
      subject: "Test",
      htmlBody: "<p>Body</p>",
    };

    // Act
    const result = await sendDraftSuperhuman(userInfo, options);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error");
  });
});
