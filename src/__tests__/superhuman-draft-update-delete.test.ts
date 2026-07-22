/**
 * SuperhumanDraftProvider Update & Delete Integration Tests
 *
 * Tests the full workflow: create → update → verify → delete → verify
 * This follows the TDD approach - test written first, expecting methods to fail.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { SuperhumanDraftProvider } from "../providers/superhuman-draft-provider";
import { createDraftWithUserInfo, getUserInfoFromCache, deleteDraftWithUserInfo } from "../draft-api";
import { saveDraftMeta, loadDraftMeta } from "../draft-cache";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
    // Track API calls; model the draft as mutable server state so the mock stays
    // correct regardless of how many getThreads reads the merge path performs.
    const fetchCalls: Array<{ url: string; method: string; body?: any }> = [];
    let createdDraftId: string | null = null;
    let createdThreadId: string | null = null;
    let deleted = false;
    // The draft's current server-side value (full object, as getThreads returns it).
    let serverDraft: Record<string, any> | null = null;

    globalThis.fetch = mock(async (url: string | URL, options?: RequestInit) => {
      const urlString = url.toString();
      const body = options?.body ? JSON.parse(options.body as string) : undefined;
      fetchCalls.push({ url: urlString, method: options?.method || "GET", body });

      if (urlString.includes("userdata.writeMessage") && body?.writes?.[0]?.path) {
        const path = body.writes[0].path;
        // Delete writes to the .../discardedAt path.
        if (path.endsWith("/discardedAt")) {
          deleted = true;
          return new Response(JSON.stringify({ success: true }));
        }
        // Create/update write the full draft value to .../draft.
        const match = path.match(/threads\/([^/]+)\/messages\/([^/]+)\//);
        if (match && !createdDraftId) {
          createdThreadId = match[1];
          createdDraftId = match[2];
        }
        // Reflect the written value as the new server state (what merge reads back).
        serverDraft = body.writes[0].value;
        return new Response(JSON.stringify({ success: true }));
      }

      if (urlString.includes("userdata.getThreads")) {
        if (deleted || !serverDraft || !createdDraftId) {
          return new Response(JSON.stringify({ threadList: [] }));
        }
        return new Response(
          JSON.stringify({
            threadList: [
              {
                id: createdThreadId, // threadId is at top level, not inside thread
                thread: { messages: { [createdDraftId]: { draft: serverDraft } } },
              },
            ],
          })
        );
      }

      return new Response(JSON.stringify({}));
    }) as unknown as typeof fetch;

    // === WORKFLOW START ===

    // 1. CREATE (setup)
    const userInfo = getUserInfoFromCache(
      mockToken.userId!,
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
    expect(draftsAfterCreate[0]!.subject).toBe("Original Subject");

    // 3. UPDATE subject only — body/to must be preserved by the merge.
    const updateSuccess = await provider.updateDraft!(testDraftId, {
      subject: "Updated Subject",
    });
    expect(updateSuccess).toBe(true);

    // 4. Verify updated (list)
    const draftsAfterUpdate = await provider.listDrafts();
    expect(draftsAfterUpdate).toHaveLength(1);
    expect(draftsAfterUpdate[0]!.subject).toBe("Updated Subject");

    // 5. DELETE
    const deleteSuccess = await provider.deleteDraft!(testDraftId);
    expect(deleteSuccess).toBe(true);

    // 6. Verify deleted (list should be empty)
    const draftsAfterDelete = await provider.listDrafts();
    expect(draftsAfterDelete).toHaveLength(0);

    // === VERIFY THE KEY CALLS HAPPENED (order-tolerant of merge reads) ===
    const writes = fetchCalls.filter((c) => c.url.includes("userdata.writeMessage"));

    // CREATE + UPDATE both write to the /draft path; DELETE writes /discardedAt.
    const createWrite = writes.find((w) => w.body.writes[0].path.endsWith("/draft"));
    expect(createWrite).toBeDefined();

    // The UPDATE write preserves body+to from the original (merge), changes subject.
    const updateWrite = writes.find(
      (w) =>
        w.body.writes[0].path.endsWith("/draft") &&
        w.body.writes[0].value.subject === "Updated Subject"
    );
    expect(updateWrite).toBeDefined();
    expect(updateWrite!.body.writes[0].value.to).toEqual(["test@example.com"]);
    expect(updateWrite!.body.writes[0].value.body).toBe("Original content");

    // DELETE writes the discardedAt path.
    const deleteWrite = writes.find((w) => w.body.writes[0].path.endsWith("/discardedAt"));
    expect(deleteWrite).toBeDefined();
  });

  it("should handle update of non-existent draft", async () => {
    // Mock fetch to return empty list
    globalThis.fetch = mock(async (url: string | URL) => {
      if (url.toString().includes("userdata.getThreads")) {
        return new Response(JSON.stringify({ threadList: [] }));
      }
      return new Response(JSON.stringify({}));
    }) as unknown as typeof fetch;

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
    }) as unknown as typeof fetch;

    // Attempt to delete non-existent draft
    await expect(provider.deleteDraft!("draft00nonexistent")).rejects.toThrow();
  });
});

describe("deleteDraftWithUserInfo local send-cache eviction", () => {
  let tmpConfigDir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.SUPERHUMAN_CLI_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "sh-cli-draft-cache-"));
    process.env.SUPERHUMAN_CLI_CONFIG_DIR = tmpConfigDir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (prevConfigDir === undefined) delete process.env.SUPERHUMAN_CLI_CONFIG_DIR;
    else process.env.SUPERHUMAN_CLI_CONFIG_DIR = prevConfigDir;
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  // Regression: `draft create` persists to/subject/htmlBody in the local
  // draft-cache so `draft send <id>` can send without re-passing the flags.
  // `draft delete` only wrote the server-side `discardedAt` tombstone and left
  // that cache entry behind, so `superhuman draft send <deleted-id>` still found
  // full metadata, performed no existence/tombstone check, and would POST
  // messages/send for a draft the user had already deleted. The send path
  // already evicts the entry (cli.ts, after a successful send) — delete must too.
  it("removes the draft-send cache entry when a draft is deleted", async () => {
    const userInfo = getUserInfoFromCache("user123", "test@example.com", "tok", "test");

    saveDraftMeta({
      draftId: "draft0027d9b73e190715",
      threadId: "draft0010bbb38b7519ef",
      to: ["Eddy Hu <eddyhu@gmail.com>"],
      subject: "ZZZ-DEBUG-h2-tombstone-send",
      htmlBody: "<p>throwaway debug draft, do not send</p>",
      createdAt: new Date().toISOString(),
    });
    expect(loadDraftMeta("draft0027d9b73e190715")).not.toBeNull();

    let tombstonePath: string | undefined;
    globalThis.fetch = mock(async (url: string | URL, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(options.body as string) : undefined;
      if (url.toString().includes("userdata.writeMessage")) {
        tombstonePath = body?.writes?.[0]?.path;
        return new Response(JSON.stringify({ success: true }));
      }
      return new Response(JSON.stringify({}));
    }) as unknown as typeof fetch;

    await deleteDraftWithUserInfo(
      userInfo,
      "draft0010bbb38b7519ef",
      "draft0027d9b73e190715"
    );

    expect(tombstonePath).toEndWith("/messages/draft0027d9b73e190715/discardedAt");
    expect(loadDraftMeta("draft0027d9b73e190715")).toBeNull();
  });

  it("keeps the cache entry when the delete write fails", async () => {
    const userInfo = getUserInfoFromCache("user123", "test@example.com", "tok", "test");

    saveDraftMeta({
      draftId: "draft00failcase",
      threadId: "thread00failcase",
      to: ["eddyhu@gmail.com"],
      subject: "ZZZ-DEBUG-h2-fail",
      htmlBody: "<p>x</p>",
      createdAt: new Date().toISOString(),
    });

    globalThis.fetch = mock(
      async () => new Response("nope", { status: 500 })
    ) as unknown as typeof fetch;

    await expect(
      deleteDraftWithUserInfo(userInfo, "thread00failcase", "draft00failcase")
    ).rejects.toThrow();

    // The draft still exists server-side, so its metadata must survive.
    expect(loadDraftMeta("draft00failcase")).not.toBeNull();
  });
});
