/**
 * Token-direct thread mutations (archive, delete, star, label, mark read/unread).
 *
 * These map to PROVIDER API calls (not a Superhuman backend endpoint — there is
 * none for per-thread Gmail/Outlook label changes; the desktop app itself calls
 * the provider directly). We mock global fetch and assert the URL + body each
 * operation sends.
 *
 *   Gmail:     POST gmail.googleapis.com/gmail/v1/users/me/threads/{id}/modify
 *              {addLabelIds, removeLabelIds}
 *   Microsoft: PATCH graph.microsoft.com/v1.0/me/messages/{id}  {isRead|flag}
 *              POST  graph.microsoft.com/v1.0/me/messages/{id}/move {destinationId}
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import type { TokenInfo } from "../token-api";
import {
  modifyThreadLabels,
  addLabel,
  removeLabel,
  starThread,
  unstarThread,
  computeMicrosoftMessageUpdates,
  computeMicrosoftMoveDestination,
} from "../labels";
import { archiveThread, deleteThread } from "../archive";
import { markAsRead, markAsUnread } from "../read-status";

// NOTE: we deliberately do NOT mock.module("../sqlite-search") — a module mock
// leaks into every test file in the same runner process. For the Microsoft
// path, readThreadFromDB finds no OPFS blob for these synthetic emails and
// resolveMsMessageIds falls back to treating the threadId as the (single)
// message id, which is exactly what we assert below.

const gmailToken: TokenInfo = {
  accessToken: "gmail-oauth",
  email: "me@example.com",
  expires: Date.now() + 3_600_000,
  isMicrosoft: false,
} as TokenInfo;

const msToken: TokenInfo = {
  accessToken: "ms-oauth",
  email: "ms@example.com",
  expires: Date.now() + 3_600_000,
  isMicrosoft: true,
} as TokenInfo;

let originalFetch: typeof globalThis.fetch;
interface Captured {
  url: string;
  method: string;
  body: any;
}
let calls: Captured[];

function mockFetch(status = 200) {
  calls = [];
  globalThis.fetch = mock((url: any, init?: RequestInit) => {
    let body: any = null;
    try {
      body = JSON.parse((init?.body as string) ?? "null");
    } catch {
      body = null;
    }
    calls.push({ url: String(url), method: init?.method ?? "GET", body });
    return Promise.resolve(new Response("{}", { status }));
  }) as any;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Gmail thread label mutations (token-direct, provider API)", () => {
  test("archiveThread removes the INBOX label via threads/{id}/modify", async () => {
    mockFetch();
    const r = await archiveThread(gmailToken, "T1");
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/threads/T1/modify"
    );
    expect(calls[0]!.body).toEqual({ addLabelIds: [], removeLabelIds: ["INBOX"] });
  });

  test("deleteThread adds the TRASH label", async () => {
    mockFetch();
    const r = await deleteThread(gmailToken, "T2");
    expect(r.success).toBe(true);
    expect(calls[0]!.body).toEqual({ addLabelIds: ["TRASH"], removeLabelIds: [] });
  });

  test("starThread adds STARRED, unstarThread removes it", async () => {
    mockFetch();
    expect((await starThread(gmailToken, "T3")).success).toBe(true);
    expect(calls[0]!.body).toEqual({ addLabelIds: ["STARRED"], removeLabelIds: [] });

    mockFetch();
    expect((await unstarThread(gmailToken, "T3")).success).toBe(true);
    expect(calls[0]!.body).toEqual({ addLabelIds: [], removeLabelIds: ["STARRED"] });
  });

  test("addLabel / removeLabel write the given label id", async () => {
    mockFetch();
    await addLabel(gmailToken, "T4", "Label_42");
    expect(calls[0]!.body).toEqual({ addLabelIds: ["Label_42"], removeLabelIds: [] });

    mockFetch();
    await removeLabel(gmailToken, "T4", "Label_42");
    expect(calls[0]!.body).toEqual({ addLabelIds: [], removeLabelIds: ["Label_42"] });
  });

  test("markAsRead removes UNREAD, markAsUnread adds it", async () => {
    mockFetch();
    expect((await markAsRead(gmailToken, "T5")).success).toBe(true);
    expect(calls[0]!.body).toEqual({ addLabelIds: [], removeLabelIds: ["UNREAD"] });

    mockFetch();
    expect((await markAsUnread(gmailToken, "T5")).success).toBe(true);
    expect(calls[0]!.body).toEqual({ addLabelIds: ["UNREAD"], removeLabelIds: [] });
  });

  test("sends the provider OAuth accessToken as the bearer", async () => {
    let authHeader = "";
    globalThis.fetch = mock((_url: any, init?: RequestInit) => {
      authHeader = (init?.headers as any)?.Authorization ?? "";
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as any;
    await modifyThreadLabels(gmailToken, "T6", ["STARRED"], []);
    expect(authHeader).toBe("Bearer gmail-oauth");
  });

  test("no-op (empty add+remove) succeeds without any request", async () => {
    mockFetch();
    const r = await modifyThreadLabels(gmailToken, "T0", [], []);
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("returns an error (not a throw) on a non-auth provider failure", async () => {
    mockFetch(500);
    const r = await modifyThreadLabels(gmailToken, "T7", ["STARRED"], []);
    expect(r.success).toBe(false);
    expect(r.error).toContain("HTTP 500");
  });

  test("returns an auth error when the token is rejected and cannot refresh", async () => {
    mockFetch(401);
    const r = await modifyThreadLabels(gmailToken, "T8", ["STARRED"], []);
    expect(r.success).toBe(false);
    expect(r.error).toContain("Authentication failed");
  });
});

describe("Microsoft thread label mutations (token-direct, MS Graph)", () => {
  test("mark read PATCHes isRead=true on the message", async () => {
    mockFetch();
    const r = await markAsRead(msToken, "C1");
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/messages/C1");
    expect(calls[0]!.body).toEqual({ isRead: true });
  });

  test("star PATCHes flag=flagged; unstar PATCHes flag=complete", async () => {
    mockFetch();
    await starThread(msToken, "C2");
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/messages/C2");
    expect(calls[0]!.body).toEqual({ flag: { flagStatus: "flagged" } });

    mockFetch();
    await unstarThread(msToken, "C2");
    expect(calls[0]!.body).toEqual({ flag: { flagStatus: "complete" } });
  });

  test("archive MOVEs the message to the archive folder (no PATCH)", async () => {
    mockFetch();
    const r = await archiveThread(msToken, "C3");
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/messages/C3/move");
    expect(calls[0]!.body).toEqual({ destinationId: "archive" });
  });

  test("delete MOVEs the message to deleteditems", async () => {
    mockFetch();
    await deleteThread(msToken, "C4");
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/messages/C4/move");
    expect(calls[0]!.body).toEqual({ destinationId: "deleteditems" });
  });
});

describe("Microsoft label → MS Graph mapping (pure)", () => {
  test("computeMicrosoftMessageUpdates: UNREAD/STARRED/importance", () => {
    expect(computeMicrosoftMessageUpdates([], ["UNREAD"])).toEqual({ isRead: true });
    expect(computeMicrosoftMessageUpdates(["UNREAD"], [])).toEqual({ isRead: false });
    expect(computeMicrosoftMessageUpdates(["STARRED"], [])).toEqual({ flag: { flagStatus: "flagged" } });
    expect(computeMicrosoftMessageUpdates([], ["STARRED"])).toEqual({ flag: { flagStatus: "complete" } });
    expect(computeMicrosoftMessageUpdates(["SH_IMPORTANT"], [])).toEqual({ inferenceClassification: "focused" });
    // INBOX/TRASH alone produce no PATCH body (they are moves, not patches).
    expect(computeMicrosoftMessageUpdates([], ["INBOX"])).toEqual({});
  });

  test("computeMicrosoftMoveDestination: archive / deleteditems / inbox", () => {
    expect(computeMicrosoftMoveDestination([], ["INBOX"])).toBe("archive");
    expect(computeMicrosoftMoveDestination(["TRASH"], [])).toBe("deleteditems");
    expect(computeMicrosoftMoveDestination(["INBOX"], [])).toBe("inbox");
    expect(computeMicrosoftMoveDestination(["STARRED"], [])).toBeNull();
  });
});
