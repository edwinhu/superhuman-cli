// src/__tests__/draft-send-e2e.test.ts
//
// E2E coverage for the CLI draft → CDP-token → messages/send flow.
//
// Two layers:
//   1. Payload regression tests (always run): stub global fetch and assert the
//      outgoing_message that sendDraftSuperhuman builds. These guard the reply
//      fix — current_message_ids must carry the thread's real per-message ids
//      (NOT the conversation/thread id), since the backend accepts a wrong id
//      with HTTP 200 then silently drops the send. No network, deterministic.
//   2. Live send-to-self (opt-in via SH_E2E_SEND=1): resolves a real token via
//      CDP, creates a native draft addressed to the account itself, sends it,
//      and asserts success. Skipped by default so `bun test` never emails anyone.
//
// Requires (live layer only): Superhuman running with --remote-debugging-port=9252.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  sendDraftSuperhuman,
  createDraftWithUserInfo,
  deleteDraftWithUserInfo,
  getUserInfoFromCache,
  type UserInfo,
} from "../draft-api";
import { resolveToken } from "../token-api";

const BACKEND = "https://mail.superhuman.com/~backend";

// ---------------------------------------------------------------------------
// Layer 1 — outgoing_message payload (no network)
// ---------------------------------------------------------------------------

/** Run `fn` with global fetch stubbed; return every parsed /messages/send body. */
async function captureSend(fn: () => Promise<unknown>): Promise<any[]> {
  const sends: any[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("/messages/send/log")) {
      return new Response("{}", { status: 200 });
    }
    if (u.includes("/messages/send")) {
      try {
        sends.push(JSON.parse(init?.body ?? "{}"));
      } catch {
        sends.push({ raw: init?.body });
      }
      return new Response(JSON.stringify({ send_at: 1_700_000_000_000 }), {
        status: 200,
      });
    }
    // Any other backend call (none expected here) — succeed quietly.
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
  return sends;
}

const fakeUser: UserInfo = {
  userId: "user-test",
  email: "self@example.com",
  token: "fake-jwt",
  timeZone: "America/New_York",
  displayName: "Self Tester",
};

describe("messages/send payload — current_message_ids", () => {
  test("reply: current_message_ids is the thread's real message ids + draft id (never the conversation id)", async () => {
    const CONVERSATION_ID = "AAQkConversationIdNotAMessageId=";
    const sends = await captureSend(() =>
      sendDraftSuperhuman(fakeUser, {
        draftId: "draft00deadbeef",
        threadId: CONVERSATION_ID,
        to: [{ email: "self@example.com", name: "Self Tester" }],
        subject: "Re: thread",
        htmlBody: "<p>reply body</p>",
        inReplyToItemId: "AAkALgaaMSG_LATEST",
        currentMessageIds: ["AAkALgaaMSG1", "AAkALgaaMSG2", "draft00deadbeef"],
      })
    );

    expect(sends.length).toBe(1);
    const om = sends[0].outgoing_message;
    expect(om.current_message_ids).toEqual([
      "AAkALgaaMSG1",
      "AAkALgaaMSG2",
      "draft00deadbeef",
    ]);
    // The conversation/thread id must NOT leak into current_message_ids — that
    // was the silent-non-delivery bug.
    expect(om.current_message_ids).not.toContain(CONVERSATION_ID);
    expect(om.in_reply_to).toBe("AAkALgaaMSG_LATEST");
  });

  test("compose (no reply ids): current_message_ids defaults to just the draft id", async () => {
    const sends = await captureSend(() =>
      sendDraftSuperhuman(fakeUser, {
        draftId: "draft00abc123",
        threadId: "draft00abc123",
        to: [{ email: "self@example.com" }],
        subject: "compose",
        htmlBody: "<p>hi</p>",
      })
    );
    expect(sends.length).toBe(1);
    expect(sends[0].outgoing_message.current_message_ids).toEqual([
      "draft00abc123",
    ]);
  });

  test("recipients are objects {email[,name]}, never a formatted 'Name <addr>' string in the email field", async () => {
    const sends = await captureSend(() =>
      sendDraftSuperhuman(fakeUser, {
        draftId: "draft00recip",
        threadId: "draft00recip",
        to: [
          { email: "bishop@law.duke.edu", name: "Bobby Bishop, Ph.D." },
          { email: "fpartnoy@berkeley.edu" },
        ],
        subject: "recips",
        htmlBody: "<p>x</p>",
      })
    );
    const om = sends[0].outgoing_message;
    // email field is a bare address; the comma-bearing display name stays in `name`.
    expect(om.to[0].email).toBe("bishop@law.duke.edu");
    expect(om.to[0].name).toBe("Bobby Bishop, Ph.D.");
    expect(om.to[1].email).toBe("fpartnoy@berkeley.edu");
    for (const r of om.to) expect(r.email).not.toContain("<");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — live send-to-self (opt-in: SH_E2E_SEND=1)
// ---------------------------------------------------------------------------

const LIVE = process.env.SH_E2E_SEND === "1";
const ACCOUNT = process.env.SH_E2E_ACCOUNT || "ehu@law.virginia.edu";

describe("live CLI draft → send (self-addressed)", () => {
  let userInfo: UserInfo | null = null;
  let skip = !LIVE;
  const created: Array<{ draftId: string; threadId: string }> = [];

  beforeAll(async () => {
    if (!LIVE) return; // opt-in only
    const token = await resolveToken(ACCOUNT);
    if (!token?.userId || !(token.superhumanToken?.token || token.idToken)) {
      skip = true;
      return;
    }
    userInfo = getUserInfoFromCache(
      token.userId,
      token.email || ACCOUNT,
      token.superhumanToken?.token || token.idToken!,
      undefined,
      token.userExternalId,
      token.deviceId
    );
  });

  afterAll(async () => {
    // Best-effort cleanup of any draft that didn't get consumed by a send.
    if (!userInfo) return;
    for (const d of created) {
      try {
        await deleteDraftWithUserInfo(userInfo, d.threadId, d.draftId);
      } catch {
        /* ignore */
      }
    }
  });

  test("creates a native compose draft to self and sends it (queue-accepted)", async () => {
    if (skip || !userInfo) {
      // Not a live run — nothing to assert; keeps the suite green by default.
      expect(LIVE).toBe(false);
      return;
    }
    const selfAddr = userInfo.email;
    const draft = await createDraftWithUserInfo(userInfo, {
      to: [selfAddr],
      subject: "draft-send-e2e self-test (ignore)",
      body: "<p>e2e self-send</p>",
      action: "compose",
    });
    expect(draft.success).toBe(true);
    created.push({ draftId: draft.draftId!, threadId: draft.threadId! });

    const sent = await sendDraftSuperhuman(userInfo, {
      draftId: draft.draftId!,
      threadId: draft.threadId!,
      to: [{ email: selfAddr }],
      subject: "draft-send-e2e self-test (ignore)",
      htmlBody: "<p>e2e self-send</p>",
    });
    expect(sent.success).toBe(true);
    // Consumed by send — drop from cleanup list.
    created.length = 0;
  });
});
