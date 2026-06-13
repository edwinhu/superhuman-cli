// src/__tests__/send-later.test.ts
//
// Native "Send Later" (server-side scheduled send): verifies the --at time
// parser and that a scheduledFor ISO string lands in the messages/send wire
// payload as outgoing_message.scheduled_for (the same field Superhuman's app
// sets — confirmed by reading the app bundle's toJsonRequest()).

import { test, expect, describe, afterEach, mock } from "bun:test";
import { parseSendAtTime } from "../snooze";
import {
  sendDraftSuperhuman,
  buildSendDraftOptions,
  getUserInfoFromCache,
} from "../draft-api";

describe("parseSendAtTime", () => {
  test("ISO datetime in the future is returned verbatim", () => {
    const d = parseSendAtTime("2099-01-02T09:00:00Z");
    expect(d.toISOString()).toBe("2099-01-02T09:00:00.000Z");
  });

  test("a past ISO datetime throws", () => {
    expect(() => parseSendAtTime("2000-01-01T00:00:00Z")).toThrow(/past/i);
  });

  test("weekday names resolve to a future date at 9am by default", () => {
    const d = parseSendAtTime("monday");
    expect(d.getTime()).toBeGreaterThan(Date.now());
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  test('"monday morning" === Monday 9am', () => {
    const d = parseSendAtTime("monday morning");
    expect(d.getDay()).toBe(1);
    expect(d.getHours()).toBe(9);
  });

  test('"next-week" preset is next Monday 9am', () => {
    const d = parseSendAtTime("next-week");
    expect(d.getDay()).toBe(1);
    expect(d.getHours()).toBe(9);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });

  test('weekday + explicit clock time, e.g. "fri 3pm"', () => {
    const d = parseSendAtTime("fri 3pm");
    expect(d.getDay()).toBe(5); // Friday
    expect(d.getHours()).toBe(15);
  });

  test('"next monday" jumps a full week past the upcoming monday', () => {
    const upcoming = parseSendAtTime("monday");
    const next = parseSendAtTime("next monday");
    const diffDays = Math.round(
      (next.getTime() - upcoming.getTime()) / (24 * 60 * 60 * 1000)
    );
    expect(diffDays).toBe(7);
  });

  test("garbage input throws", () => {
    expect(() => parseSendAtTime("not a real time")).toThrow();
  });
});

describe("buildSendDraftOptions threads scheduledFor", () => {
  test("scheduledFor is carried into the assembled SendDraftOptions", () => {
    const iso = "2099-01-02T09:00:00.000Z";
    const built = buildSendDraftOptions({
      draftId: "draft00abc",
      threadId: "draft00abc",
      to: [{ email: "self@example.com" }],
      subject: "hi",
      htmlBody: "<p>hi</p>",
      scheduledFor: iso,
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.options.scheduledFor).toBe(iso);
  });
});

describe("sendDraftSuperhuman emits scheduled_for", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function captureSendBody(): { get: () => any } {
    let sendBody: any = null;
    const mockFn = mock((url: string, init?: RequestInit) => {
      // The real send goes to /messages/send (not /log). Capture that body.
      if (
        typeof url === "string" &&
        url.endsWith("/messages/send") &&
        init?.body
      ) {
        sendBody = JSON.parse(init.body as string);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ send_at: Date.now() }),
        text: () => Promise.resolve(""),
      } as Response);
    });
    globalThis.fetch = mockFn as unknown as typeof fetch;
    return { get: () => sendBody };
  }

  test("scheduledFor ISO becomes outgoing_message.scheduled_for", async () => {
    const cap = captureSendBody();
    const userInfo = getUserInfoFromCache(
      "uid",
      "self@example.com",
      "tok",
      "Self"
    );
    const iso = "2099-01-02T09:00:00.000Z";
    const res = await sendDraftSuperhuman(userInfo, {
      draftId: "draft00abc",
      threadId: "draft00abc",
      to: [{ email: "self@example.com" }],
      subject: "hi",
      htmlBody: "<p>hi</p>",
      scheduledFor: iso,
      noSignature: true,
    });
    expect(res.success).toBe(true);
    const body = cap.get();
    expect(body).not.toBeNull();
    expect(body.outgoing_message.scheduled_for).toBe(iso);
    // delay stays the undo-window default, independent of scheduling.
    expect(body.delay).toBe(20);
  });

  test("no scheduledFor → scheduled_for is null (immediate send)", async () => {
    const cap = captureSendBody();
    const userInfo = getUserInfoFromCache("uid", "self@example.com", "tok", "Self");
    await sendDraftSuperhuman(userInfo, {
      draftId: "draft00abc",
      threadId: "draft00abc",
      to: [{ email: "self@example.com" }],
      subject: "hi",
      htmlBody: "<p>hi</p>",
      noSignature: true,
    });
    expect(cap.get().outgoing_message.scheduled_for).toBeNull();
  });
});
