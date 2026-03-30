/**
 * SuperhumanDraftProvider Update & Delete Integration Tests
 *
 * Tests the full workflow: create → update → verify → delete → verify
 * This follows the TDD approach - test written first, expecting methods to fail.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { SuperhumanDraftProvider } from "../providers/superhuman-draft-provider";
import { createDraftWithUserInfo, getUserInfoFromCache } from "../draft-api";
import type { TokenInfo } from "../token-api";
import type { Draft } from "../services/draft-service";

// Store original fetch
const originalFetch = globalThis.fetch;

describe("SuperhumanDraftProvider update/delete", () => {
  let mockToken: TokenInfo;
  let provider: SuperhumanDraftProvider;

  beforeEach(() => {
    mockToken = {
      accessToken: "mock-access-token",
      idToken: "mock-id-token",
      refreshToken: "mock-refresh-token",
      expires: Date.now() + 3600000,
      email: "test@example.com",
      userId: "user123",
      isMicrosoft: false,
      superhumanToken: {
        token: "mock-superhuman-token",
        expires: Date.now() + 3600000,
      },
      userPrefix: "abcd", // Required for some API calls
    };
    provider = new SuperhumanDraftProvider(mockToken);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should update and delete native draft", async () => {
    // Track API calls and created draft ID
    const fetchCalls: Array<{ url: string; method: string; body?: any }> = [];
    let createdDraftId: string | null = null;
    let createdThreadId: string | null = null;

    // Mock fetch to capture and respond to API calls
    globalThis.fetch = mock(async (url: string | URL, options?: RequestInit) => {
      const urlString = url.toString();
      const body = options?.body ? JSON.parse(options.body as string) : undefined;

      fetchCalls.push({
        url: urlString,
        method: options?.method || "GET",
        body,
      });

      // 1. Initial CREATE (setup) - capture draft ID from write request
      if (urlString.includes("userdata.writeMessage") && body?.writes?.[0]?.path) {
        const path = body.writes[0].path;
        // Extract IDs from path: users/{userId}/threads/{threadId}/messages/{draftId}/draft
        const match = path.match(/threads\/([^/]+)\/messages\/([^/]+)\//);
        if (match && !createdDraftId) {
          createdThreadId = match[1];
          createdDraftId = match[2];
        }
        return new Response(JSON.stringify({ success: true }));
      }

      // 2-4. LIST calls - return appropriate draft state
      if (urlString.includes("userdata.getThreads")) {
        // After create/update: return the draft
        if (fetchCalls.length <= 4 && createdDraftId) {
          const subject = fetchCalls.length === 4 ? "Updated Subject" : "Original Subject";
          return new Response(
            JSON.stringify({
              threadList: [
                {
                  id: createdThreadId, // threadId is at top level, not inside thread
                  thread: {
                    messages: {
                      [createdDraftId]: {
                        draft: {
                          id: createdDraftId,
                          subject,
                          to: ["test@example.com"],
                          from: "user@example.com",
                          snippet: "Original content",
                          date: "2026-02-08T12:00:00Z",
                        },
                      },
                    },
                  },
                },
              ],
            })
          );
        }

        // After delete: return empty
        return new Response(JSON.stringify({ threadList: [] }));
      }

      // Fallback
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    // === WORKFLOW START ===

    // 1. CREATE (setup)
    const userInfo = getUserInfoFromCache(
      mockToken.userId,
      mockToken.email,
      mockToken.superhumanToken!.token,
      "Test User"
    );

    const createResult = await createDraftWithUserInfo(userInfo, {
      to: ["test@example.com"],
      subject: "Original Subject",
      body: "Original content",
    });

    expect(createResult.success).toBe(true);
    expect(createResult.draftId).toBeDefined();

    const testDraftId = createResult.draftId!;

    // 2. Verify created (list)
    const draftsAfterCreate = await provider.listDrafts();
    expect(draftsAfterCreate).toHaveLength(1);
    expect(draftsAfterCreate[0].subject).toBe("Original Subject");

    // 3. UPDATE - this will fail with "updateDraft is not a function"
    const updateSuccess = await provider.updateDraft!(testDraftId, {
      subject: "Updated Subject",
    });
    expect(updateSuccess).toBe(true);

    // 4. Verify updated (list)
    const draftsAfterUpdate = await provider.listDrafts();
    expect(draftsAfterUpdate).toHaveLength(1);
    expect(draftsAfterUpdate[0].subject).toBe("Updated Subject");

    // 5. DELETE - this will fail with "deleteDraft is not a function"
    const deleteSuccess = await provider.deleteDraft!(testDraftId);
    expect(deleteSuccess).toBe(true);

    // 6. Verify deleted (list should be empty)
    const draftsAfterDelete = await provider.listDrafts();
    expect(draftsAfterDelete).toHaveLength(0);

    // === VERIFY API CALL SEQUENCE ===
    expect(fetchCalls).toHaveLength(6);

    // CREATE call
    expect(fetchCalls[0].url).toContain("userdata.writeMessage");
    expect(fetchCalls[0].body.writes[0].path).toContain("/draft");

    // First LIST call
    expect(fetchCalls[1].url).toContain("userdata.getThreads");

    // UPDATE call (reuses writeMessage)
    expect(fetchCalls[2].url).toContain("userdata.writeMessage");
    expect(fetchCalls[2].body.writes[0].value.subject).toBe("Updated Subject");

    // Second LIST call
    expect(fetchCalls[3].url).toContain("userdata.getThreads");

    // DELETE call (writeMessage with discardedAt path)
    expect(fetchCalls[4].url).toContain("userdata.writeMessage");
    // The path should include /discardedAt
    expect(fetchCalls[4].body.writes[0].path).toContain("/discardedAt");

    // Final LIST call
    expect(fetchCalls[5].url).toContain("userdata.getThreads");
  });

  it("should handle update of non-existent draft", async () => {
    // Mock fetch to return empty list
    globalThis.fetch = mock(async (url: string | URL) => {
      if (url.toString().includes("userdata.getThreads")) {
        return new Response(JSON.stringify({ threadList: [] }));
      }
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    // Attempt to update non-existent draft
    await expect(
      provider.updateDraft!("draft00nonexistent", { subject: "New Subject" })
    ).rejects.toThrow();
  });

  it("should handle delete of non-existent draft", async () => {
    // Mock fetch to return empty list
    globalThis.fetch = mock(async (url: string | URL) => {
      if (url.toString().includes("userdata.getThreads")) {
        return new Response(JSON.stringify({ threadList: [] }));
      }
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    // Attempt to delete non-existent draft
    await expect(provider.deleteDraft!("draft00nonexistent")).rejects.toThrow();
  });
});
