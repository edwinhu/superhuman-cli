/**
 * Regression tests for `draft update` MERGE semantics.
 *
 * Bug (fixed 2026-06-02): `updateDraftWithUserInfo` built a complete draft value
 * and wrote it to the draft path. Since `userdata.writeMessage` REPLACES the whole
 * value, any field the caller didn't pass (To / Subject / CC / references / …) was
 * blanked. A body-only `draft update` silently reset to:[] and subject:"".
 *
 * The fix fetches the current draft (userdata.getThreads) and merges: only fields
 * explicitly passed in DraftOptions override the existing values.
 */

import { describe, it, expect, mock, afterEach } from "bun:test";
import { updateDraftWithUserInfo, type UserInfo } from "../draft-api";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const userInfo: UserInfo = {
  userId: "user123",
  email: "eddyhu@gmail.com",
  token: "mock-token",
  timeZone: "America/New_York",
};

const THREAD_ID = "19a92997276093dc";
const DRAFT_ID = "draft00abc123";

// The existing draft as userdata.getThreads returns it.
const EXISTING_DRAFT = {
  schemaVersion: 3,
  id: DRAFT_ID,
  action: "reply",
  from: "eddyhu <eddyhu@gmail.com>",
  to: ["help@sleep.me"],
  cc: ["cc@example.com"],
  subject: "Re: [Sleep.me] Re: Leak",
  body: "<p>original body</p>",
  snippet: "original body",
  rfc822Id: "<original-message-id@we.are.superhuman.com>",
  inReplyToRfc822Id: "<thread-parent@mail.gmail.com>",
  references: ["<ref1@mail.gmail.com>", "<ref2@mail.gmail.com>"],
  labelIds: ["DRAFT"],
  fingerprint: { to: "help@sleep.me", cc: "cc@example.com", attachments: "" },
  autoDraftKind: "MEETING_REQUEST",
};

/**
 * Mock fetch: getThreads returns EXISTING_DRAFT; writeMessage records the payload.
 * Returns a getter for the draft value that was written.
 */
function mockBackend() {
  let written: any = null;
  globalThis.fetch = mock(async (url: string, init: RequestInit) => {
    if (url.includes("userdata.getThreads")) {
      return new Response(
        JSON.stringify({
          threadList: [
            { id: THREAD_ID, thread: { messages: { [DRAFT_ID]: { draft: EXISTING_DRAFT } } } },
          ],
        })
      );
    }
    if (url.includes("userdata.writeMessage")) {
      const body = JSON.parse(init.body as string);
      written = body.writes[0].value;
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return () => written;
}

describe("draft update — merge, not replace", () => {
  it("body-only update preserves To, CC, Subject, references and threading", async () => {
    const getWritten = mockBackend();

    const ok = await updateDraftWithUserInfo(userInfo, THREAD_ID, DRAFT_ID, {
      body: "<p>new body</p>",
    });
    expect(ok).toBe(true);

    const w = getWritten();
    expect(w.body).toBe("<p>new body</p>"); // changed
    expect(w.to).toEqual(["help@sleep.me"]); // preserved (was blanked before)
    expect(w.cc).toEqual(["cc@example.com"]); // preserved
    expect(w.subject).toBe("Re: [Sleep.me] Re: Leak"); // preserved
    expect(w.references).toEqual([
      "<ref1@mail.gmail.com>",
      "<ref2@mail.gmail.com>",
    ]); // preserved
    expect(w.inReplyToRfc822Id).toBe("<thread-parent@mail.gmail.com>"); // threading preserved
    expect(w.rfc822Id).toBe("<original-message-id@we.are.superhuman.com>"); // message-id NOT regenerated
    expect(w.snippet).toBe("new body"); // snippet recomputed from new body
    expect(w.fingerprint.to).toBe("help@sleep.me"); // fingerprint kept in sync with preserved To
  });

  it("subject-only update preserves To and body", async () => {
    const getWritten = mockBackend();

    await updateDraftWithUserInfo(userInfo, THREAD_ID, DRAFT_ID, {
      subject: "New subject",
    });

    const w = getWritten();
    expect(w.subject).toBe("New subject"); // changed
    expect(w.to).toEqual(["help@sleep.me"]); // preserved
    expect(w.body).toBe("<p>original body</p>"); // preserved (NOT reset to a snippet)
  });

  it("to-only update preserves Subject and body, and updates fingerprint", async () => {
    const getWritten = mockBackend();

    await updateDraftWithUserInfo(userInfo, THREAD_ID, DRAFT_ID, {
      to: ["new@example.com", "other@example.com"],
    });

    const w = getWritten();
    expect(w.to).toEqual(["new@example.com", "other@example.com"]); // changed
    expect(w.fingerprint.to).toBe("new@example.com,other@example.com"); // fingerprint follows To
    expect(w.subject).toBe("Re: [Sleep.me] Re: Leak"); // preserved
    expect(w.body).toBe("<p>original body</p>"); // preserved
  });

  it("carries forward unmanaged fields (autoDraftKind)", async () => {
    const getWritten = mockBackend();
    await updateDraftWithUserInfo(userInfo, THREAD_ID, DRAFT_ID, { body: "<p>x</p>" });
    expect(getWritten().autoDraftKind).toBe("MEETING_REQUEST");
  });

  it("REFUSES to write (throws) when the existing draft can't be fetched", async () => {
    // If getThreads can't return the draft (not found / backend down), a blind
    // write would blank To/Subject/body — the original bug. The update must throw
    // and must NOT issue a writeMessage.
    let writeCalled = false;
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("userdata.getThreads")) {
        return new Response(JSON.stringify({ threadList: [] }));
      }
      writeCalled = true;
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    await expect(
      updateDraftWithUserInfo(userInfo, THREAD_ID, DRAFT_ID, { body: "<p>B</p>" })
    ).rejects.toThrow(/Cannot read current state|Refusing to overwrite/);
    expect(writeCalled).toBe(false); // never blanked the draft
  });

  it("pages past the first 100 drafts to find the target (no silent blanking)", async () => {
    // Backend caps limit at 100; the target draft is on the 2nd page. fetchDraftValue
    // must page with offset and still merge correctly.
    const PAGE = 100;
    const filler = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `t${i}`,
        thread: { messages: { [`draft00filler${i}`]: { draft: { id: `draft00filler${i}` } } } },
      }));
    let written: any = null;
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      if (url.includes("userdata.getThreads")) {
        const { offset } = JSON.parse(init.body as string);
        if (offset === 0) {
          return new Response(JSON.stringify({ threadList: filler(PAGE) })); // full page, no target
        }
        // 2nd page contains the target
        return new Response(
          JSON.stringify({
            threadList: [
              { id: THREAD_ID, thread: { messages: { [DRAFT_ID]: { draft: EXISTING_DRAFT } } } },
            ],
          })
        );
      }
      written = JSON.parse(init.body as string).writes[0].value;
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    const ok = await updateDraftWithUserInfo(userInfo, THREAD_ID, DRAFT_ID, {
      body: "<p>new body</p>",
    });
    expect(ok).toBe(true);
    expect(written.to).toEqual(["help@sleep.me"]); // preserved from page 2
    expect(written.subject).toBe("Re: [Sleep.me] Re: Leak");
  });
});
