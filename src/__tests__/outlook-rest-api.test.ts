/**
 * Tests for outlook-rest-api.ts — the Outlook REST v2.0 data functions.
 *
 * Each data function takes an injectable `OwaFetcher`. We supply a mock that
 * records (method, path, body) and returns raw OWA REST fixtures, then assert
 * BOTH the emitted superhuman shape AND the REST path/method/body issued.
 */

import { test, expect, describe, mock } from "bun:test";
import {
  owaListInbox,
  owaSearch,
  owaGetThread,
  owaCreateDraft,
  owaReply,
  owaForward,
  owaSendDraft,
  owaSendNew,
  owaArchive,
  owaDelete,
  owaMarkRead,
  owaFlag,
  owaListStarred,
  owaListLabels,
  owaAddLabel,
  owaRemoveLabel,
  owaListEvents,
  owaListAttachments,
  owaAddAttachment,
  OWA_MAX_ATTACHMENT_BYTES,
  owaContacts,
  owaListDrafts,
  type OwaFetcher,
} from "../outlook-rest-api";

const ME = "ehu@law.virginia.edu";

/** A recording fetcher whose responses are keyed by "METHOD path-prefix". */
function makeFetcher(handler: (method: string, path: string, body?: any) => any) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const fn: OwaFetcher = mock(async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    return handler(method, path, body);
  });
  return { fn, calls };
}

/** A raw OWA message fixture. */
function owaMessage(over: Record<string, any> = {}) {
  return {
    Id: "AAMkAGmsg1",
    Subject: "Hello there",
    From: { EmailAddress: { Name: "Alice", Address: "alice@x.com" } },
    ToRecipients: [{ EmailAddress: { Name: "Me", Address: ME } }],
    CcRecipients: [{ EmailAddress: { Name: "Bob", Address: "bob@x.com" } }],
    ReceivedDateTime: "2026-07-19T12:00:00Z",
    BodyPreview: "preview text",
    ConversationId: "CONV1",
    IsRead: false,
    Flag: { FlagStatus: "NotFlagged" },
    Categories: ["Work"],
    InternetMessageId: "<abc@x.com>",
    ...over,
  };
}

describe("owaListInbox", () => {
  test("maps messages to InboxThread and hits the inbox messages path", async () => {
    const { fn, calls } = makeFetcher(() => ({ value: [owaMessage()] }));

    const threads = await owaListInbox(fn, ME, { limit: 5 });

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toContain("/mailfolders/inbox/messages");
    expect(calls[0]!.path).toContain("$top=5");
    expect(calls[0]!.path).toContain("ReceivedDateTime%20desc");

    expect(threads).toHaveLength(1);
    const t = threads[0]!;
    expect(t.id).toBe("AAMkAGmsg1");
    expect(t.subject).toBe("Hello there");
    expect(t.from).toEqual({ email: "alice@x.com", name: "Alice" });
    expect(t.to).toEqual([{ email: ME, name: "Me" }]);
    expect(t.cc).toEqual([{ email: "bob@x.com", name: "Bob" }]);
    expect(t.date).toBe("2026-07-19T12:00:00Z");
    expect(t.snippet).toBe("preview text");
    expect(t.messageCount).toBe(1);
    // Unread + a category → UNREAD label + the category; not flagged → no STARRED.
    expect(t.labelIds).toEqual(["UNREAD", "Work"]);
    expect(t.isFromMe).toBe(false);
    expect(t.awaitingReply).toBe(true);
  });

  test("isFromMe true when From is the account; STARRED label when flagged", async () => {
    const { fn } = makeFetcher(() => ({
      value: [
        owaMessage({
          From: { EmailAddress: { Name: "Me", Address: ME } },
          IsRead: true,
          Flag: { FlagStatus: "Flagged" },
          Categories: [],
        }),
      ],
    }));
    const threads = await owaListInbox(fn, ME, {});
    expect(threads[0]!.isFromMe).toBe(true);
    expect(threads[0]!.awaitingReply).toBe(false);
    expect(threads[0]!.labelIds).toEqual(["STARRED"]);
  });

  test("needsReply filters out messages the account sent", async () => {
    const { fn } = makeFetcher(() => ({
      value: [
        owaMessage({ Id: "m-them", From: { EmailAddress: { Address: "them@x.com" } } }),
        owaMessage({ Id: "m-me", From: { EmailAddress: { Address: ME } } }),
      ],
    }));
    const threads = await owaListInbox(fn, ME, { needsReply: true });
    expect(threads.map((t) => t.id)).toEqual(["m-them"]);
  });

  test("withBody adds Body to $select and populates body", async () => {
    const { fn, calls } = makeFetcher(() => ({
      value: [owaMessage({ Body: { ContentType: "HTML", Content: "<p>hi</p>" } })],
    }));
    const threads = await owaListInbox(fn, ME, { withBody: true });
    expect(decodeURIComponent(calls[0]!.path)).toContain("Body");
    expect((threads[0] as any).body).toBe("<p>hi</p>");
  });
});

describe("owaSearch", () => {
  test("issues a $search query and maps results", async () => {
    const { fn, calls } = makeFetcher(() => ({ value: [owaMessage()] }));
    const res = await owaSearch(fn, ME, "invoice", { limit: 3 });
    expect(calls[0]!.path).toContain("/messages?");
    expect(decodeURIComponent(calls[0]!.path)).toContain('$search="invoice"');
    expect(res[0]!.subject).toBe("Hello there");
  });
});

describe("owaGetThread", () => {
  test("resolves ConversationId then lists the conversation oldest-first", async () => {
    const { fn, calls } = makeFetcher((method, path) => {
      if (path.includes("$select=ConversationId") && !path.includes("filter")) {
        return { ConversationId: "CONV9" };
      }
      return {
        value: [
          owaMessage({ Id: "m1", ConversationId: "CONV9", Body: { Content: "first" } }),
          owaMessage({ Id: "m2", ConversationId: "CONV9", Body: { Content: "second" } }),
        ],
      };
    });

    const msgs = await owaGetThread(fn, "AAMkAGmsg1");

    // First call resolves the conversation id; second filters by it.
    expect(calls[0]!.path).toContain("/messages/AAMkAGmsg1");
    expect(decodeURIComponent(calls[1]!.path)).toContain("ConversationId eq 'CONV9'");
    // No $orderby with $filter (Exchange InefficientFilter); sorted client-side.
    expect(calls[1]!.path).not.toContain("orderby");

    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.id).toBe("m1");
    expect(msgs[0]!.threadId).toBe("CONV9");
    expect(msgs[0]!.body).toBe("first");
    expect(msgs[1]!.body).toBe("second");
  });
});

describe("owaCreateDraft", () => {
  test("POSTs /messages with recipient + body and returns the id", async () => {
    const { fn, calls } = makeFetcher(() => ({ Id: "draftAA", ConversationId: "cX" }));
    const res = await owaCreateDraft(fn, {
      to: ["Carol <carol@x.com>"],
      cc: ["dave@x.com"],
      subject: "Hi",
      body: "<p>body</p>",
      html: true,
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/messages");
    const body = calls[0]!.body;
    expect(body.Subject).toBe("Hi");
    expect(body.Body).toEqual({ ContentType: "HTML", Content: "<p>body</p>" });
    expect(body.ToRecipients).toEqual([
      { EmailAddress: { Name: "Carol", Address: "carol@x.com" } },
    ]);
    expect(body.CcRecipients).toEqual([{ EmailAddress: { Address: "dave@x.com" } }]);
    expect(res).toEqual({ id: "draftAA", threadId: "cX" });
  });
});

describe("owaReply", () => {
  test("createReply then PATCH body prepended above the quote", async () => {
    const { fn, calls } = makeFetcher((method, path) => {
      if (path.endsWith("/createReply")) {
        return { Id: "reply1", ConversationId: "cc", Body: { Content: "<quote>" } };
      }
      return null;
    });
    const res = await owaReply(fn, "msgX", { body: "my reply", html: true, all: false });
    expect(calls[0]!.path).toBe("/messages/msgX/createReply");
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.path).toBe("/messages/reply1");
    expect(calls[1]!.body.Body.Content).toBe("my reply<br><br><quote>");
    expect(res.id).toBe("reply1");
  });

  test("all:true uses createReplyAll", async () => {
    const { fn, calls } = makeFetcher(() => ({ Id: "r2", Body: { Content: "" } }));
    await owaReply(fn, "msgX", { body: "hi", all: true });
    expect(calls[0]!.path).toBe("/messages/msgX/createReplyAll");
  });
});

describe("owaForward", () => {
  test("createForward then PATCH recipients + body", async () => {
    const { fn, calls } = makeFetcher((method, path) => {
      if (path.endsWith("/createForward")) return { Id: "fwd1", Body: { Content: "<orig>" } };
      return null;
    });
    await owaForward(fn, "msgX", { to: ["z@x.com"], body: "fyi", html: true });
    expect(calls[0]!.path).toBe("/messages/msgX/createForward");
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.body.ToRecipients).toEqual([{ EmailAddress: { Address: "z@x.com" } }]);
    expect(calls[1]!.body.Body.Content).toBe("fyi<br><br><orig>");
  });
});

describe("owaSendDraft / owaSendNew", () => {
  test("owaSendDraft POSTs /send", async () => {
    const { fn, calls } = makeFetcher(() => null);
    await owaSendDraft(fn, "draftAA");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/messages/draftAA/send");
  });

  test("owaSendNew POSTs /sendmail with SaveToSentItems", async () => {
    const { fn, calls } = makeFetcher(() => null);
    await owaSendNew(fn, { to: ["a@x.com"], subject: "S", body: "B", html: true });
    expect(calls[0]!.path).toBe("/sendmail");
    expect(calls[0]!.body.SaveToSentItems).toBe(true);
    expect(calls[0]!.body.Message.Subject).toBe("S");
    expect(calls[0]!.body.Message.ToRecipients).toEqual([
      { EmailAddress: { Address: "a@x.com" } },
    ]);
  });
});

describe("owaArchive / owaDelete (move, never hard delete)", () => {
  test("archive moves to the archive folder", async () => {
    const { fn, calls } = makeFetcher(() => null);
    await owaArchive(fn, ["m1", "m2"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.path).toBe("/messages/m1/move");
    expect(calls[0]!.body).toEqual({ DestinationId: "archive" });
  });

  test("delete moves to deleteditems (trash), not a hard delete", async () => {
    const { fn, calls } = makeFetcher(() => null);
    await owaDelete(fn, ["m1"]);
    expect(calls[0]!.path).toBe("/messages/m1/move");
    expect(calls[0]!.body).toEqual({ DestinationId: "deleteditems" });
  });
});

describe("owaMarkRead / owaFlag", () => {
  test("markRead PATCHes IsRead", async () => {
    const { fn, calls } = makeFetcher(() => null);
    await owaMarkRead(fn, "m1", true);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({ IsRead: true });
  });

  test("flag PATCHes Flag.FlagStatus", async () => {
    const { fn, calls } = makeFetcher(() => null);
    await owaFlag(fn, "m1", true);
    expect(calls[0]!.body).toEqual({ Flag: { FlagStatus: "Flagged" } });
    await owaFlag(fn, "m1", false);
    expect(calls[1]!.body).toEqual({ Flag: { FlagStatus: "NotFlagged" } });
  });
});

describe("owaListStarred", () => {
  test("filters on flagged and maps to StarredThread", async () => {
    const { fn, calls } = makeFetcher(() => ({
      value: [owaMessage({ Flag: { FlagStatus: "Flagged" } })],
    }));
    const res = await owaListStarred(fn, ME, { limit: 10 });
    expect(decodeURIComponent(calls[0]!.path)).toContain("Flag/FlagStatus eq 'Flagged'");
    expect(res[0]!.id).toBe("AAMkAGmsg1");
    expect(res[0]!.subject).toBe("Hello there");
    expect(res[0]!.from).toEqual({ email: "alice@x.com", name: "Alice" });
  });
});

describe("owaListLabels / owaAddLabel / owaRemoveLabel", () => {
  test("lists folders as labels", async () => {
    const { fn, calls } = makeFetcher(() => ({
      value: [{ Id: "F1", DisplayName: "Receipts" }],
    }));
    const labels = await owaListLabels(fn);
    expect(calls[0]!.path).toContain("/mailfolders");
    expect(labels).toEqual([{ id: "F1", name: "Receipts", type: "folder" }]);
  });

  test("addLabel merges into existing Categories", async () => {
    const { fn, calls } = makeFetcher((method, path) => {
      if (method === "GET") return { Categories: ["Old"] };
      return null;
    });
    await owaAddLabel(fn, "m1", "New");
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.body).toEqual({ Categories: ["Old", "New"] });
  });

  test("removeLabel drops the category", async () => {
    const { fn, calls } = makeFetcher((method) => {
      if (method === "GET") return { Categories: ["Old", "New"] };
      return null;
    });
    await owaRemoveLabel(fn, "m1", "Old");
    expect(calls[1]!.body).toEqual({ Categories: ["New"] });
  });
});

describe("owaListEvents", () => {
  test("maps calendarview events to CalendarEvent", async () => {
    const { fn, calls } = makeFetcher(() => ({
      value: [
        {
          Id: "ev1",
          Subject: "Faculty Lunch",
          Body: { Content: "notes" },
          Start: { DateTime: "2026-07-20T16:00:00", TimeZone: "UTC" },
          End: { DateTime: "2026-07-20T17:00:00", TimeZone: "UTC" },
          Location: { DisplayName: "Room 1" },
          Attendees: [{ EmailAddress: { Address: "guest@x.com" } }],
          Organizer: { EmailAddress: { Address: "org@x.com" } },
          IsAllDay: false,
          ShowAs: "Busy",
        },
      ],
    }));
    const events = await owaListEvents(fn, { timeMin: "A", timeMax: "B", limit: 5 });
    expect(calls[0]!.path).toContain("/calendarview?");
    const e = events[0]!;
    expect(e).toEqual({
      id: "ev1",
      summary: "Faculty Lunch",
      description: "notes",
      start: "2026-07-20T16:00:00",
      end: "2026-07-20T17:00:00",
      location: "Room 1",
      attendees: ["guest@x.com"],
      organizer: "org@x.com",
      isAllDay: false,
      status: "Busy",
      calendarId: "",
    });
  });
});

describe("owaListAttachments", () => {
  test("maps non-inline attachments; drops inline", async () => {
    const { fn, calls } = makeFetcher(() => ({
      value: [
        { Id: "att1", Name: "report.pdf", ContentType: "application/pdf", Size: 1000, IsInline: false },
        { Id: "att2", Name: "logo.png", ContentType: "image/png", Size: 20, IsInline: true },
      ],
    }));
    const atts = await owaListAttachments(fn, "msgX");
    expect(calls[0]!.path).toContain("/messages/msgX/attachments");
    expect(atts).toHaveLength(1);
    expect(atts[0]).toEqual({
      id: "att1",
      attachmentId: "att1",
      name: "report.pdf",
      mimeType: "application/pdf",
      extension: "pdf",
      messageId: "msgX",
      threadId: "msgX",
      inline: false,
    });
  });
});

describe("owaAddAttachment", () => {
  test("POSTs an inline base64 FileAttachment to the draft", async () => {
    const { fn, calls } = makeFetcher(() => ({ Id: "att1" }));
    await owaAddAttachment(fn, "draft1", {
      name: "note.eml",
      mimeType: "message/rfc822",
      base64: "QUJD",
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/messages/draft1/attachments");
    expect(calls[0]!.body).toEqual({
      "@odata.type": "#Microsoft.OutlookServices.FileAttachment",
      Name: "note.eml",
      ContentType: "message/rfc822",
      ContentBytes: "QUJD",
    });
  });

  test("rejects files over the inline POST ceiling without calling the API", async () => {
    const { fn, calls } = makeFetcher(() => ({}));
    const oversized = "A".repeat(Math.ceil(((OWA_MAX_ATTACHMENT_BYTES + 1024 * 1024) * 4) / 3));
    await expect(
      owaAddAttachment(fn, "draft1", { name: "big.bin", mimeType: "application/octet-stream", base64: oversized })
    ).rejects.toThrow(/big\.bin is .*MB/);
    expect(calls).toHaveLength(0);
  });
});

describe("owaContacts", () => {
  test("substring-matches name/email and returns Contact shape", async () => {
    const { fn } = makeFetcher(() => ({
      value: [
        { DisplayName: "Nadya Malenko", EmailAddresses: [{ Address: "malenko@bc.edu" }] },
        { DisplayName: "Someone Else", EmailAddresses: [{ Address: "else@x.com" }] },
      ],
    }));
    const contacts = await owaContacts(fn, "malenko");
    expect(contacts).toEqual([{ email: "malenko@bc.edu", name: "Nadya Malenko" }]);
  });
});

describe("owaListDrafts", () => {
  test("maps drafts folder messages to the Draft contract", async () => {
    const { fn, calls } = makeFetcher(() => ({
      value: [
        owaMessage({
          Id: "d1",
          Subject: "WIP",
          From: { EmailAddress: { Name: "Me", Address: ME } },
          ToRecipients: [{ EmailAddress: { Address: "x@x.com" } }],
          CcRecipients: [],
        }),
      ],
    }));
    const drafts = await owaListDrafts(fn, 25);
    expect(calls[0]!.path).toContain("/mailfolders/drafts/messages");
    expect(drafts[0]).toEqual({
      id: "d1",
      subject: "WIP",
      from: `Me <${ME}>`,
      to: ["x@x.com"],
      cc: [],
      bcc: [],
      preview: "preview text",
      timestamp: "2026-07-19T12:00:00Z",
      source: "native",
      threadId: "CONV1",
    });
  });
});
