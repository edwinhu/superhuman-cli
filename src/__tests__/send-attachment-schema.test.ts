/**
 * Regression tests for the outgoing_message.attachments[] schema produced by
 * sendDraftSuperhuman().
 *
 * Background: a stripped `source:{type:"upload",uuid}` reference (the old shape)
 * is accepted by /messages/send (HTTP 200, queued) but later fails delivery,
 * surfacing as a "failed to send" notice ~10 min later — the silent
 * non-delivery bug. The send payload must carry the full reference so the
 * backend can resolve the uploaded blob when it assembles the MIME.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  sendDraftSuperhuman,
  getUserInfoFromCache,
  type SuperhumanAttachment,
} from "../draft-api";

const userInfo = getUserInfoFromCache(
  "user-id-123",
  "user@example.com",
  "test-bearer-token",
  "Test User"
);

const attachment: SuperhumanAttachment = {
  uuid: "att-uuid-1",
  cid: "cid-uuid-1",
  name: "report.docx",
  type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  inline: false,
  downloadUrl: "https://media.superhuman.com/v2/superhuman/attachments/blob-123",
  threadId: "thread-abc",
  messageId: "draft00deadbeef",
  size: 4096,
};

describe("sendDraftSuperhuman outgoing attachment schema", () => {
  let originalFetch: typeof globalThis.fetch;
  let sendBody: any = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    sendBody = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/messages/send")) {
        sendBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ send_at: 1780000000000 }), { status: 200 });
      }
      // /messages/send/log and anything else: succeed quietly
      return new Response("{}", { status: 200 });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("matches the app's toJsonRequest shape (cid + source.{type:upload-firebase,ids})", async () => {
    const res = await sendDraftSuperhuman(userInfo, {
      draftId: "draft00deadbeef",
      threadId: "thread-abc",
      to: [{ email: "user@example.com" }],
      subject: "with attachment",
      htmlBody: "<p>hi</p>",
      attachments: [attachment],
    });

    expect(res.success).toBe(true);
    expect(sendBody).not.toBeNull();

    const outAtts = sendBody.outgoing_message.attachments;
    expect(outAtts).toHaveLength(1);
    const a = outAtts[0];

    // Top-level reference fields the backend needs (no `size` — app omits it).
    expect(a.uuid).toBe("att-uuid-1");
    expect(a.cid).toBe("cid-uuid-1");
    expect(a.name).toBe("report.docx");
    expect(a.size).toBeUndefined();

    // Captured from a real app send: source carries ONLY these four keys.
    // type must be "upload-firebase"; the blob is referenced by id (no url).
    expect(a.source.type).toBe("upload-firebase");
    expect(a.source.uuid).toBe("att-uuid-1");
    expect(a.source.thread_id).toBe("thread-abc");
    expect(a.source.message_id).toBe("draft00deadbeef");
    // The app OMITS these for an upload — including them makes the backend reject.
    expect(a.source.cid).toBeUndefined();
    expect(a.source.fixed_part_id).toBeUndefined();
    expect(a.source.attachment_id).toBeUndefined();
    expect(a.source.url).toBeUndefined();
    expect(Object.keys(a.source).sort()).toEqual(["message_id", "thread_id", "type", "uuid"]);
  });

  test("falls back to draft/thread ids when an attachment omits them", async () => {
    const partial: SuperhumanAttachment = {
      ...attachment,
      // Simulate an older cache entry missing the new fields.
      threadId: undefined as unknown as string,
      messageId: undefined as unknown as string,
      cid: undefined as unknown as string,
    };

    await sendDraftSuperhuman(userInfo, {
      draftId: "draft00deadbeef",
      threadId: "thread-abc",
      to: [{ email: "user@example.com" }],
      subject: "partial attachment",
      htmlBody: "<p>hi</p>",
      attachments: [partial],
    });

    const a = sendBody.outgoing_message.attachments[0];
    expect(a.cid).toBe("att-uuid-1"); // falls back to uuid
    expect(a.source.thread_id).toBe("thread-abc"); // falls back to options.threadId
    expect(a.source.message_id).toBe("draft00deadbeef"); // falls back to options.draftId
  });

  test("reply threading: current_message_ids + in_reply_to use provider item ids", async () => {
    await sendDraftSuperhuman(userInfo, {
      draftId: "draft00reply",
      threadId: "AAQk-conversation-id",
      to: [{ email: "other@example.com" }],
      subject: "Re: hi",
      htmlBody: "<p>reply</p>",
      inReplyTo: "<rfc822-id@we.are.superhuman.com>",
      inReplyToItemId: "AAkA-original-item-id",
      currentMessageIds: ["AAkA-original-item-id", "draft00reply"],
    });
    const om = sendBody.outgoing_message;
    // in_reply_to (top-level) is the provider item id, NOT the rfc822 id...
    expect(om.in_reply_to).toBe("AAkA-original-item-id");
    // ...while the rfc822 id stays in the In-Reply-To MIME header.
    const inReplyHeader = om.headers.find((h: any) => h.name === "In-Reply-To");
    expect(inReplyHeader.value).toBe("<rfc822-id@we.are.superhuman.com>");
    // current_message_ids carries the prior thread message id + the draft.
    expect(om.current_message_ids).toEqual(["AAkA-original-item-id", "draft00reply"]);
  });

  test("compose default: current_message_ids is [draftId] when not a reply", async () => {
    await sendDraftSuperhuman(userInfo, {
      draftId: "draft00compose",
      threadId: "draft00compose",
      to: [{ email: "a@example.com" }],
      subject: "hi",
      htmlBody: "<p>hi</p>",
    });
    expect(sendBody.outgoing_message.current_message_ids).toEqual(["draft00compose"]);
  });

  test("emits an empty array when there are no attachments", async () => {
    await sendDraftSuperhuman(userInfo, {
      draftId: "draft00deadbeef",
      threadId: "thread-abc",
      to: [{ email: "user@example.com" }],
      subject: "no attachments",
      htmlBody: "<p>hi</p>",
    });
    expect(sendBody.outgoing_message.attachments).toEqual([]);
  });
});
