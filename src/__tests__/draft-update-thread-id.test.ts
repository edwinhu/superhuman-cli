/**
 * Regression: `updateDraftViaProvider` must resolve the draft's real owning
 * thread instead of passing the draft id as the thread id.
 *
 * The old code wrote to users/{u}/threads/{draftId}/messages/{draftId}/draft.
 * `userdata.writeMessage` returns 200 for a write to a path that does not
 * exist, so the update reported success — but the write also CREATES that
 * path, forking the draft into a second copy on a phantom thread.
 *
 * Demonstrated live 2026-08-03 (eddyhu@gmail.com, throwaway draft
 * draft007b9ac23fa2d2c9, real thread draft002c5c8842ab140d): after one
 * wrong-threadId update, `draft list --json` returned the SAME draft id twice
 * with different bodies and different threadIds:
 *   preview=MUTATED-BY-CORRECT-THREADID  thread=draft002c5c8842ab140d
 *   preview=MUTATED-BY-WRONG-THREADID    thread=draft007b9ac23fa2d2c9
 * A later `draft delete` tombstones only whichever copy findDraftMessage hits
 * first, so the other survives — one mechanism behind duplicate drafts
 * accumulating on a thread.
 *
 * This is the same defect class fixed for `deleteDraftViaProvider` in #38.
 */

import { test, expect, describe, mock, afterAll } from "bun:test";
import * as draftApi from "../draft-api";

const REAL_DRAFT_API = { ...draftApi };

afterAll(() => {
  mock.module("../draft-api", () => REAL_DRAFT_API);
});

/** Minimal SuperhumanProvider stand-in that satisfies userInfoFromProvider(). */
async function makeProvider() {
  const { SuperhumanProvider } = await import("../superhuman-provider");
  const provider = Object.create(SuperhumanProvider.prototype) as any;
  provider.getToken = async () => ({
    userId: "user_1",
    superhumanToken: { token: "jwt" },
    userExternalId: "ext_1",
    deviceId: "dev_1",
  });
  provider.getCurrentEmail = async () => "user@example.com";
  return provider;
}

describe("updateDraftViaProvider thread resolution", () => {
  test("writes using the draft's real threadId, not the draft id", async () => {
    const calls: Array<{ threadId: string; draftId: string }> = [];

    mock.module("../draft-api", () => ({
      ...REAL_DRAFT_API,
      findDraftMessage: async () => ({
        threadId: "draft002c5c8842ab140d",
        discardedAt: null,
        draft: { body: "<p>ORIGINAL</p>" },
      }),
      updateDraftWithUserInfo: async (_u: any, threadId: string, draftId: string) => {
        calls.push({ threadId, draftId });
        return true;
      },
    }));

    const { updateDraftViaProvider } = await import("../send-api");
    const result = await updateDraftViaProvider(await makeProvider(), "draft007b9ac23fa2d2c9", {
      body: "edited",
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.threadId).toBe("draft002c5c8842ab140d");
    // The bug: threadId === draftId. That must never happen again.
    expect(calls[0]!.threadId).not.toBe(calls[0]!.draftId);
  });

  // findDraftMessage deliberately still returns tombstoned records, so an
  // existence check alone lets an update land beneath a discarded message:
  // success is reported, the edit is never visible. Flagged independently by
  // both the Codex and Gemini reviews of PR #39.
  test("refuses to update a draft that carries a discardedAt tombstone", async () => {
    let wrote = false;

    mock.module("../draft-api", () => ({
      ...REAL_DRAFT_API,
      findDraftMessage: async () => ({
        threadId: "draft002c5c8842ab140d",
        discardedAt: "2026-08-03T14:40:00.000Z",
        draft: { body: "<p>ORIGINAL</p>" },
      }),
      updateDraftWithUserInfo: async () => {
        wrote = true;
        return true;
      },
    }));

    const { updateDraftViaProvider } = await import("../send-api");
    const result = await updateDraftViaProvider(await makeProvider(), "draft007b9ac23fa2d2c9", {
      body: "edited",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/deleted/i);
    expect(wrote).toBe(false);
  });

  test("surfaces an error message when the backend rejects the update", async () => {
    mock.module("../draft-api", () => ({
      ...REAL_DRAFT_API,
      findDraftMessage: async () => ({
        threadId: "draft002c5c8842ab140d",
        discardedAt: null,
        draft: { body: "<p>ORIGINAL</p>" },
      }),
      updateDraftWithUserInfo: async () => false,
    }));

    const { updateDraftViaProvider } = await import("../send-api");
    const result = await updateDraftViaProvider(await makeProvider(), "draft007b9ac23fa2d2c9", {
      body: "edited",
    });

    expect(result.success).toBe(false);
    // success:false with error:undefined gives the caller nothing to print.
    expect(result.error).toBeTruthy();
  });

  test("reports failure instead of forking when the draft cannot be located", async () => {
    let wrote = false;

    mock.module("../draft-api", () => ({
      ...REAL_DRAFT_API,
      findDraftMessage: async () => null,
      updateDraftWithUserInfo: async () => {
        wrote = true;
        return true;
      },
    }));

    const { updateDraftViaProvider } = await import("../send-api");
    const result = await updateDraftViaProvider(await makeProvider(), "draft00missing", {
      body: "edited",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    // Critically: no blind write to a guessed path.
    expect(wrote).toBe(false);
  });
});
