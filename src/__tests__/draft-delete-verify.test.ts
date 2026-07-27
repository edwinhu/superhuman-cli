/**
 * Regression tests for `draft delete` reporting success without deleting.
 *
 * Observed 2026-07-27: `superhuman draft delete draft005c92f1117aa74e` printed
 * "✓ Deleted native draft …" and exited 0, but the draft kept coming back from
 * `draft list`. `userdata.writeMessage` returns HTTP 200 for a write to a path
 * that matches nothing (e.g. a wrong threadId), so a 200 alone never proved the
 * tombstone landed — the CLI reported success purely on the status code.
 *
 * These tests pin: (1) the tombstone is read back before ✓ is printed, (2) a
 * write that is accepted but does not take is reported as a failure, and
 * (3) the owning threadId is resolved from the draft index rather than guessed.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  deleteDraftWithUserInfo,
  findDraftMessage,
  verifyDraftDiscarded,
  getUserInfoFromCache,
} from "../draft-api";
import { saveDraftMeta, loadDraftMeta } from "../draft-cache";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalFetch = globalThis.fetch;
const userInfo = () => getUserInfoFromCache("user123", "test@example.com", "tok", "test");

const DRAFT_ID = "draft00aaaabbbbccccdd";
const THREAD_ID = "19fa4dd4951c2c40";

/**
 * Mock backend holding one draft message, optionally tombstoned. `writeAccepted`
 * models the real backend: the write returns 200 whatever path it targets, and
 * only a write to the CORRECT path actually sets discardedAt.
 */
function mockBackend(opts: { discardedAt?: string | null; threadId?: string } = {}) {
  const state = {
    discardedAt: opts.discardedAt ?? null as string | null,
    writePaths: [] as string[],
  };
  const threadId = opts.threadId ?? THREAD_ID;

  globalThis.fetch = mock(async (url: string | URL, options?: RequestInit) => {
    const u = url.toString();
    const body = options?.body ? JSON.parse(options.body as string) : undefined;

    if (u.includes("userdata.writeMessage")) {
      const path: string = body?.writes?.[0]?.path ?? "";
      state.writePaths.push(path);
      // Only the correct path mutates state — everything else is a silent no-op
      // that the backend still answers 200 to.
      if (path === `users/user123/threads/${threadId}/messages/${DRAFT_ID}/discardedAt`) {
        state.discardedAt = body.writes[0].value;
      }
      return new Response(JSON.stringify({ success: true }));
    }

    if (u.includes("userdata.getThreads")) {
      return new Response(
        JSON.stringify({
          threadList: [
            {
              id: threadId,
              thread: {
                messages: {
                  [DRAFT_ID]: {
                    ...(state.discardedAt ? { discardedAt: state.discardedAt } : {}),
                    draft: { id: DRAFT_ID, threadId, subject: "throwaway" },
                  },
                },
              },
            },
          ],
        })
      );
    }

    return new Response(JSON.stringify({}));
  }) as unknown as typeof fetch;

  return state;
}

describe("draft delete verification", () => {
  let tmpConfigDir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.SUPERHUMAN_CLI_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "sh-cli-delete-verify-"));
    process.env.SUPERHUMAN_CLI_CONFIG_DIR = tmpConfigDir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (prevConfigDir === undefined) delete process.env.SUPERHUMAN_CLI_CONFIG_DIR;
    else process.env.SUPERHUMAN_CLI_CONFIG_DIR = prevConfigDir;
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  it("resolves the owning threadId from the draft index", async () => {
    mockBackend();
    const located = await findDraftMessage(userInfo(), DRAFT_ID);
    expect(located?.threadId).toBe(THREAD_ID);
    expect(located?.discardedAt).toBeNull();
  });

  it("succeeds and writes the tombstone when the threadId is right", async () => {
    const state = mockBackend();
    await deleteDraftWithUserInfo(userInfo(), THREAD_ID, DRAFT_ID);
    expect(state.discardedAt).not.toBeNull();
    expect(state.writePaths[0]).toBe(
      `users/user123/threads/${THREAD_ID}/messages/${DRAFT_ID}/discardedAt`
    );
  });

  it("THROWS when the write is accepted (200) but the draft is still live", async () => {
    // The exact production failure: a wrong threadId. The backend answers 200,
    // no tombstone is set, and the old code printed ✓ anyway.
    const state = mockBackend();
    await expect(
      deleteDraftWithUserInfo(userInfo(), "wrong-thread-id", DRAFT_ID, {
        // no retry delay — the mock is deterministic
      })
    ).rejects.toThrow(/not deleted/);
    expect(state.discardedAt).toBeNull();
  });

  it("keeps the local send-cache entry when the delete did not take", async () => {
    // Otherwise a `draft send <id>` for a draft the user believes is deleted
    // would still find full metadata locally.
    mockBackend();
    saveDraftMeta({
      draftId: DRAFT_ID,
      threadId: THREAD_ID,
      to: ["eddyhu@gmail.com"],
      subject: "throwaway",
      htmlBody: "<p>x</p>",
      createdAt: new Date().toISOString(),
    });

    await expect(
      deleteDraftWithUserInfo(userInfo(), "wrong-thread-id", DRAFT_ID)
    ).rejects.toThrow();

    expect(loadDraftMeta(DRAFT_ID)).not.toBeNull();
  });

  it("treats a draft absent from the index as deleted", async () => {
    globalThis.fetch = mock(async (url: string | URL) => {
      if (url.toString().includes("userdata.getThreads")) {
        return new Response(JSON.stringify({ threadList: [] }));
      }
      return new Response(JSON.stringify({ success: true }));
    }) as unknown as typeof fetch;

    expect(await verifyDraftDiscarded(userInfo(), DRAFT_ID, 1)).toBe(true);
  });

  it("treats an already-tombstoned draft as deleted", async () => {
    mockBackend({ discardedAt: "2026-07-27T23:16:10.013000000Z" });
    expect(await verifyDraftDiscarded(userInfo(), DRAFT_ID, 1)).toBe(true);
  });

  it("does not treat a live draft as deleted", async () => {
    mockBackend();
    expect(await verifyDraftDiscarded(userInfo(), DRAFT_ID, 1)).toBe(false);
  });

  it("skips the read-back when verify:false (post-send cleanup path)", async () => {
    let getThreadsCalls = 0;
    globalThis.fetch = mock(async (url: string | URL) => {
      if (url.toString().includes("userdata.getThreads")) getThreadsCalls++;
      return new Response(JSON.stringify({ success: true }));
    }) as unknown as typeof fetch;

    await deleteDraftWithUserInfo(userInfo(), THREAD_ID, DRAFT_ID, { verify: false });
    expect(getThreadsCalls).toBe(0);
  });
});
