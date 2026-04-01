/**
 * Tests for calendar.ts using SuperhumanProvider (gcal DI service via CDP).
 *
 * Mocks the CDP Runtime.evaluate to intercept gcal service calls.
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import { SuperhumanProvider } from "../superhuman-provider";
import type { SuperhumanTokenInfo } from "../superhuman-provider";
import type { SuperhumanConnection } from "../superhuman-api";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getFreeBusy,
} from "../calendar";
import { setTokenCacheForTest, clearTokenCache, type TokenInfo } from "../token-api";

const sampleToken: SuperhumanTokenInfo = {
  token: "test-jwt-token",
  email: "user@example.com",
  accountId: "acct_123",
  expires: Date.now() + 3600_000,
};

/**
 * Create a mock SuperhumanConnection whose Runtime.evaluate
 * captures expressions and returns a canned value.
 */
function makeMockConn(returnValue: any) {
  const evaluateMock = mock(() =>
    Promise.resolve({
      result: { type: "object" as const, value: returnValue },
    })
  );

  const conn = {
    client: {},
    Runtime: { evaluate: evaluateMock },
    Input: {},
    Network: {},
    Page: {},
  } as unknown as SuperhumanConnection;

  return { conn, evaluateMock };
}

/** Helper: create a provider WITH portal (CDP connection) */
function providerWithPortal(returnValue: any) {
  const { conn, evaluateMock } = makeMockConn(returnValue);
  const provider = new SuperhumanProvider(sampleToken, conn);
  return { provider, evaluateMock };
}

/** Helper: create a provider WITHOUT portal */
function providerWithoutPortal() {
  return new SuperhumanProvider(sampleToken);
}

describe("calendar with SuperhumanProvider (CDP gcal)", () => {
  beforeEach(() => {
    clearTokenCache();
    // Set up Google token cache so isMicrosoftAccount() returns false
    setTokenCacheForTest("user@example.com", {
      accessToken: "mock",
      email: "user@example.com",
      expires: Date.now() + 3600000,
      isMicrosoft: false,
    } as TokenInfo);
  });

  // ---------- listEvents ----------

  describe("listEvents", () => {
    test("calls gcal.getEventsList via Runtime.evaluate", async () => {
      const rawEvents = {
        items: [
          {
            id: "evt_1",
            summary: "Team Standup",
            description: "Daily sync",
            start: { dateTime: "2026-03-31T09:00:00Z" },
            end: { dateTime: "2026-03-31T09:30:00Z" },
            location: "Zoom",
            attendees: [{ email: "alice@example.com" }],
            organizer: { email: "user@example.com" },
            status: "confirmed",
          },
        ],
      };

      const { provider, evaluateMock } = providerWithPortal(rawEvents);

      const events = await listEvents(provider, {
        timeMin: "2026-03-31T00:00:00Z",
        timeMax: "2026-04-01T00:00:00Z",
        limit: 10,
      });

      expect(evaluateMock).toHaveBeenCalledTimes(1);
      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain("di.get('gcal').getEventsList");
      expect(expr).toContain('"primary"');
      expect(expr).toContain('"singleEvents":true');
      expect(expr).toContain('"maxResults":10');

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("evt_1");
      expect(events[0].summary).toBe("Team Standup");
      expect(events[0].start).toBe("2026-03-31T09:00:00Z");
      expect(events[0].attendees).toEqual(["alice@example.com"]);
    });

    test("uses custom calendarId when provided", async () => {
      const { provider, evaluateMock } = providerWithPortal({ items: [] });

      await listEvents(provider, { calendarId: "work@example.com" });

      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain('"work@example.com"');
    });

    test("returns empty array on error", async () => {
      const evaluateMock = mock(() =>
        Promise.resolve({
          exceptionDetails: {
            text: "gcal service not available",
          },
          result: { type: "undefined" as const },
        })
      );
      const conn = {
        client: {},
        Runtime: { evaluate: evaluateMock },
        Input: {},
        Network: {},
        Page: {},
      } as unknown as SuperhumanConnection;

      const provider = new SuperhumanProvider(sampleToken, conn);
      const events = await listEvents(provider);
      expect(events).toEqual([]);
    });

    test("gcalInvoke injects calendarAccountEmail into expression", async () => {
      const { provider, evaluateMock } = providerWithPortal({ items: [] });

      await listEvents(provider, {
        timeMin: "2026-03-31T00:00:00Z",
        timeMax: "2026-04-01T00:00:00Z",
      });

      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain('"calendarAccountEmail":"user@example.com"');
    });

    test("normalizes all-day events", async () => {
      const rawEvents = {
        items: [
          {
            id: "evt_allday",
            summary: "Conference",
            start: { date: "2026-04-01" },
            end: { date: "2026-04-02" },
          },
        ],
      };
      const { provider } = providerWithPortal(rawEvents);
      const events = await listEvents(provider);

      expect(events[0].isAllDay).toBe(true);
      expect(events[0].start).toBe("2026-04-01");
    });
  });

  // ---------- createEvent ----------

  describe("createEvent", () => {
    test("calls gcal.importEvent via Runtime.evaluate", async () => {
      const { provider, evaluateMock } = providerWithPortal({
        id: "new_evt_1",
      });

      const result = await createEvent(provider, {
        summary: "Lunch",
        start: "2026-03-31T12:00:00Z",
        end: "2026-03-31T13:00:00Z",
        description: "Team lunch",
        location: "Cafe",
        attendees: ["bob@example.com"],
      });

      expect(result.success).toBe(true);
      expect(result.eventId).toBe("new_evt_1");

      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain("di.get('gcal').importEvent");
      expect(expr).toContain('"user@example.com"');
      expect(expr).toContain('"summary":"Lunch"');
      expect(expr).toContain('"description":"Team lunch"');
      expect(expr).toContain('"location":"Cafe"');
    });

    test("returns error on failure", async () => {
      const evaluateMock = mock(() =>
        Promise.resolve({
          exceptionDetails: { text: "quota exceeded" },
          result: { type: "undefined" as const },
        })
      );
      const conn = {
        client: {},
        Runtime: { evaluate: evaluateMock },
        Input: {},
        Network: {},
        Page: {},
      } as unknown as SuperhumanConnection;

      const provider = new SuperhumanProvider(sampleToken, conn);
      const result = await createEvent(provider, {
        summary: "Test",
        start: "2026-03-31T12:00:00Z",
        end: "2026-03-31T13:00:00Z",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("quota exceeded");
    });
  });

  // ---------- updateEvent ----------

  describe("updateEvent", () => {
    test("calls gcal.patchEvent via Runtime.evaluate", async () => {
      const { provider, evaluateMock } = providerWithPortal({
        id: "evt_1",
      });

      const result = await updateEvent(
        provider,
        "evt_1",
        { summary: "Updated Standup", location: "Room 42" },
        "work@example.com"
      );

      expect(result.success).toBe(true);
      expect(result.eventId).toBe("evt_1");

      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain("di.get('gcal').patchEvent");
      expect(expr).toContain('"work@example.com"');
      expect(expr).toContain('"evt_1"');
      expect(expr).toContain('"summary":"Updated Standup"');
    });

    test("uses 'primary' calendarId by default", async () => {
      const { provider, evaluateMock } = providerWithPortal({ id: "evt_1" });

      await updateEvent(provider, "evt_1", { summary: "X" });

      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain('"primary"');
    });
  });

  // ---------- deleteEvent ----------

  describe("deleteEvent", () => {
    test("calls gcal.deleteEvent via Runtime.evaluate", async () => {
      const { provider, evaluateMock } = providerWithPortal(undefined);

      const result = await deleteEvent(provider, "evt_1", "work@example.com");

      expect(result.success).toBe(true);

      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain("di.get('gcal').deleteEvent");
      expect(expr).toContain('"work@example.com"');
      expect(expr).toContain('"evt_1"');
    });

    test("uses 'primary' calendarId by default", async () => {
      const { provider, evaluateMock } = providerWithPortal(undefined);

      await deleteEvent(provider, "evt_1");

      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain('"primary"');
    });

    test("returns error on failure", async () => {
      const evaluateMock = mock(() =>
        Promise.resolve({
          exceptionDetails: { text: "not found" },
          result: { type: "undefined" as const },
        })
      );
      const conn = {
        client: {},
        Runtime: { evaluate: evaluateMock },
        Input: {},
        Network: {},
        Page: {},
      } as unknown as SuperhumanConnection;

      const provider = new SuperhumanProvider(sampleToken, conn);
      const result = await deleteEvent(provider, "evt_1");

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  // ---------- getFreeBusy ----------

  describe("getFreeBusy", () => {
    test("calls gcal.queryFreeBusy via Runtime.evaluate", async () => {
      const freeBusyResponse = {
        calendars: {
          "user@example.com": {
            busy: [
              { start: "2026-03-31T09:00:00Z", end: "2026-03-31T10:00:00Z" },
            ],
          },
        },
      };
      const { provider, evaluateMock } = providerWithPortal(freeBusyResponse);

      const result = await getFreeBusy(provider, {
        timeMin: "2026-03-31T00:00:00Z",
        timeMax: "2026-04-01T00:00:00Z",
        calendarIds: ["user@example.com"],
      });

      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain("di.get('gcal').queryFreeBusy");
      expect(expr).toContain('"timeMin"');
      expect(expr).toContain('"items"');

      expect(result.busy).toHaveLength(1);
      expect(result.busy[0].start).toBe("2026-03-31T09:00:00Z");
      expect(result.busy[0].end).toBe("2026-03-31T10:00:00Z");
    });

    test("returns empty on error", async () => {
      const evaluateMock = mock(() =>
        Promise.resolve({
          exceptionDetails: { text: "service unavailable" },
          result: { type: "undefined" as const },
        })
      );
      const conn = {
        client: {},
        Runtime: { evaluate: evaluateMock },
        Input: {},
        Network: {},
        Page: {},
      } as unknown as SuperhumanConnection;

      const provider = new SuperhumanProvider(sampleToken, conn);
      const result = await getFreeBusy(provider, {
        timeMin: "2026-03-31T00:00:00Z",
        timeMax: "2026-04-01T00:00:00Z",
      });

      expect(result.busy).toEqual([]);
      expect(result.free).toEqual([]);
    });
  });

  // ---------- No portal ----------

  describe("without portal (no CDP connection)", () => {
    test("listEvents throws for non-MCP provider without portal", async () => {
      const provider = providerWithoutPortal();
      // SuperhumanProvider without portal should throw
      expect(listEvents(provider)).rejects.toThrow(
        /Calendar requires.*Superhuman app/
      );
    });

    test("createEvent throws for non-MCP provider without portal", async () => {
      const provider = providerWithoutPortal();
      expect(
        createEvent(provider, {
          summary: "Test",
          start: "2026-03-31T12:00:00Z",
          end: "2026-03-31T13:00:00Z",
        })
      ).rejects.toThrow(/Calendar requires.*Superhuman app/);
    });

    test("updateEvent throws for non-MCP provider without portal", async () => {
      const provider = providerWithoutPortal();
      expect(
        updateEvent(provider, "evt_1", { summary: "X" })
      ).rejects.toThrow(/Calendar requires.*Superhuman app/);
    });

    test("deleteEvent throws for non-MCP provider without portal", async () => {
      const provider = providerWithoutPortal();
      expect(deleteEvent(provider, "evt_1")).rejects.toThrow(
        /Calendar requires.*Superhuman app/
      );
    });

    test("getFreeBusy throws for non-MCP provider without portal", async () => {
      const provider = providerWithoutPortal();
      expect(
        getFreeBusy(provider, {
          timeMin: "2026-03-31T00:00:00Z",
          timeMax: "2026-04-01T00:00:00Z",
        })
      ).rejects.toThrow(/Calendar requires.*Superhuman app/);
    });
  });
});

// ---------------------------------------------------------------------------
// MS Graph calendar routing tests
// ---------------------------------------------------------------------------

describe("calendar with SuperhumanProvider (MS Graph)", () => {
  const msToken: SuperhumanTokenInfo = {
    token: "test-jwt-token",
    email: "user@outlook.com",
    accountId: "acct_ms",
    expires: Date.now() + 3600_000,
  };

  function makeMsMockConn(returnValue: any) {
    const evaluateMock = mock(() =>
      Promise.resolve({
        result: { type: "object" as const, value: returnValue },
      })
    );
    const conn = {
      client: {},
      Runtime: { evaluate: evaluateMock },
      Input: {},
      Network: {},
      Page: {},
    } as unknown as SuperhumanConnection;
    return { conn, evaluateMock };
  }

  function msProviderWithPortal(returnValue: any) {
    const { conn, evaluateMock } = makeMsMockConn(returnValue);
    const provider = new SuperhumanProvider(msToken, conn);
    return { provider, evaluateMock };
  }

  beforeEach(() => {
    clearTokenCache();
    setTokenCacheForTest("user@outlook.com", {
      accessToken: "mock",
      email: "user@outlook.com",
      expires: Date.now() + 3600000,
      isMicrosoft: true,
    } as TokenInfo);
  });

  // ---------- listEvents (MS) ----------

  describe("listEvents", () => {
    test("routes to requestMicrosoftCalendar with calendarView endpoint", async () => {
      const msEvents = {
        value: [
          {
            id: "ms_evt_1",
            subject: "Team Standup",
            bodyPreview: "Daily sync",
            start: { dateTime: "2026-03-31T09:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-03-31T09:30:00.0000000", timeZone: "UTC" },
            location: { displayName: "Teams Room" },
            attendees: [
              { emailAddress: { address: "alice@outlook.com", name: "Alice" } },
            ],
            organizer: { emailAddress: { address: "user@outlook.com" } },
            showAs: "busy",
          },
        ],
      };

      const { provider, evaluateMock } = msProviderWithPortal(msEvents);

      const events = await listEvents(provider, {
        timeMin: "2026-03-31T00:00:00Z",
        timeMax: "2026-04-01T00:00:00Z",
        limit: 10,
      });

      expect(evaluateMock).toHaveBeenCalledTimes(1);
      const expr = evaluateMock.mock.calls[0][0].expression as string;

      // Must use MS Graph proxy, NOT gcal DI
      expect(expr).toContain("requestMicrosoftCalendar");
      expect(expr).not.toContain("di.get('gcal')");
      expect(expr).toContain("user@outlook.com");
      expect(expr).toContain("calendarView");

      // Verify normalization from MS field names
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("ms_evt_1");
      expect(events[0].summary).toBe("Team Standup");
      expect(events[0].description).toBe("Daily sync");
      expect(events[0].location).toBe("Teams Room");
      expect(events[0].attendees).toEqual(["alice@outlook.com"]);
    });
  });

  // ---------- createEvent (MS) ----------

  describe("createEvent", () => {
    test("sends POST to me/events with MS field names", async () => {
      const { provider, evaluateMock } = msProviderWithPortal({
        id: "ms_new_evt_1",
      });

      const result = await createEvent(provider, {
        summary: "Lunch Meeting",
        start: "2026-03-31T12:00:00Z",
        end: "2026-03-31T13:00:00Z",
        description: "Team lunch",
        location: "Cafe",
        attendees: ["bob@outlook.com"],
      });

      expect(result.success).toBe(true);
      expect(result.eventId).toBe("ms_new_evt_1");

      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain("requestMicrosoftCalendar");
      expect(expr).not.toContain("di.get('gcal')");
      expect(expr).toContain("me/events");
      expect(expr).toContain('"POST"');

      // MS field names in body
      expect(expr).toContain('"subject":"Lunch Meeting"');
      expect(expr).toContain('"displayName":"Cafe"');
      expect(expr).toContain('"bob@outlook.com"');

      // Body should be passed as object, not headers field
      expect(expr).not.toContain("headers:");
    });
  });

  // ---------- updateEvent (MS) ----------

  describe("updateEvent", () => {
    test("sends PATCH to me/events/{id} with MS field names", async () => {
      const { provider, evaluateMock } = msProviderWithPortal({
        id: "ms_evt_1",
      });

      const result = await updateEvent(provider, "ms_evt_1", {
        summary: "Updated Standup",
        location: "Room 42",
      });

      expect(result.success).toBe(true);
      expect(result.eventId).toBe("ms_evt_1");

      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain("requestMicrosoftCalendar");
      expect(expr).not.toContain("di.get('gcal')");
      expect(expr).toContain("me/events/ms_evt_1");
      expect(expr).toContain('"PATCH"');
      expect(expr).toContain('"subject":"Updated Standup"');
      expect(expr).toContain('"displayName":"Room 42"');
      expect(expr).not.toContain("headers:");
    });
  });

  // ---------- deleteEvent (MS) ----------

  describe("deleteEvent", () => {
    test("sends DELETE to me/events/{id}", async () => {
      const { provider, evaluateMock } = msProviderWithPortal(undefined);

      const result = await deleteEvent(provider, "ms_evt_1");

      expect(result.success).toBe(true);

      const expr = evaluateMock.mock.calls[0][0].expression as string;
      expect(expr).toContain("requestMicrosoftCalendar");
      expect(expr).not.toContain("di.get('gcal')");
      expect(expr).toContain("me/events/ms_evt_1");
      expect(expr).toContain('"DELETE"');
      expect(expr).not.toContain("headers:");
    });
  });
});
