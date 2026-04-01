/**
 * Calendar Module
 *
 * Functions for calendar operations via Superhuman's gcal DI service (CDP).
 */

import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";
import { getCachedTokenRaw } from "./token-api";

/**
 * Represents a calendar event
 */
export interface CalendarEvent {
  id: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  organizer: string;
  isAllDay: boolean;
  status: string;
  calendarId: string;
}

/**
 * Input for creating a calendar event
 */
export interface CreateEventInput {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  calendarId?: string;
}

/**
 * Input for updating a calendar event
 */
export interface UpdateEventInput {
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  attendees?: string[];
}

/**
 * A free/busy time slot
 */
export interface FreeBusySlot {
  start: string;
  end: string;
}

/**
 * Result of a calendar operation (create, update, delete)
 */
export interface CalendarResult {
  success: boolean;
  eventId?: string;
  error?: string;
}

/**
 * Result of a free/busy query
 */
export interface FreeBusyResult {
  busy: FreeBusySlot[];
  free: FreeBusySlot[];
}

/**
 * Options for listing events
 */
export interface ListEventsOptions {
  calendarId?: string;
  timeMin?: Date | string;
  timeMax?: Date | string;
  limit?: number;
}

/**
 * Options for checking free/busy availability
 */
export interface FreeBusyOptions {
  timeMin: Date | string;
  timeMax: Date | string;
  calendarIds?: string[]; // Optional: specific calendars to check
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toISOString(v: Date | string): string {
  return typeof v === "string" ? v : v.toISOString();
}

/**
 * Call a method on the Superhuman gcal DI service via CDP Runtime.evaluate.
 *
 * The expression resolves to:
 *   window.GoogleAccount.di.get('gcal').<method>(...args)
 */
async function gcalInvoke(
  provider: SuperhumanProvider,
  method: string,
  args: any[]
): Promise<any> {
  const email = await provider.getCurrentEmail();
  // Inject calendarAccountEmail into the first arg (gcal methods expect it there)
  const firstArg = args[0];
  if (firstArg && typeof firstArg === "object" && !Array.isArray(firstArg)) {
    firstArg.calendarAccountEmail = email;
  } else {
    // First arg is a scalar (e.g. calendarId string) — wrap into object
    args[0] = { calendarId: firstArg || "primary", calendarAccountEmail: email };
  }
  const argsLiteral = args.map((a) => JSON.stringify(a)).join(", ");
  const expression = `window.GoogleAccount.di.get('gcal').${method}(${argsLiteral})`;
  return provider.runtimeEvaluate(expression);
}

/**
 * Check if the current account is a Microsoft account.
 * Uses the token cache (reliable per-account) rather than CDP page state.
 */
async function isMicrosoftAccount(provider: SuperhumanProvider): Promise<boolean> {
  const email = await provider.getCurrentEmail();
  const token = await getCachedTokenRaw(email);
  return !!token?.isMicrosoft;
}

/**
 * Call the MS Graph calendar proxy via Superhuman's backend.
 */
async function msCalendarRequest(
  provider: SuperhumanProvider,
  url: string,
  method: string = "GET",
  body?: any,
  endpoint: string = "microsoftCalendar.proxy"
): Promise<any> {
  const email = await provider.getCurrentEmail();
  const expression = `
    window.GoogleAccount.backend.requestMicrosoftCalendar({
      account: ${JSON.stringify(email)},
      url: ${JSON.stringify(url)},
      endpoint: ${JSON.stringify(endpoint)},
      method: ${JSON.stringify(method)},
      ${body ? `body: ${JSON.stringify(body)},` : ""}
    })
  `;
  return provider.runtimeEvaluate(expression);
}

/**
 * Normalize a raw event object (from gcal DI or MS Graph) into a CalendarEvent.
 */
function normalizeEvent(e: any): CalendarEvent {
  // The gcal service returns Google Calendar API-shaped objects
  const startRaw = e.start?.dateTime || e.start?.date || e.start || "";
  const endRaw = e.end?.dateTime || e.end?.date || e.end || "";
  const isAllDay = !!(e.start?.date && !e.start?.dateTime);

  return {
    id: e.id || e.event_id || "",
    summary: e.summary || e.title || e.subject || "",
    description: e.description || e.bodyPreview || e.body?.content || "",
    start: startRaw,
    end: endRaw,
    location: e.location?.displayName || e.location || "",
    attendees: (e.attendees || []).map(
      (a: any) => a.emailAddress?.address || a.email || a.displayName || a
    ),
    organizer:
      e.organizer?.emailAddress?.address || e.organizer?.email || e.organizer?.displayName || e.organizer || "",
    isAllDay,
    status: e.status || e.showAs || "",
    calendarId: e.calendarId || e.calendar_id || "",
  };
}

/**
 * Throw when no SuperhumanProvider with portal is available.
 */
function requirePortal(): never {
  throw new Error(
    "Calendar requires a running Superhuman app (CDP connection)."
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List calendar events within a time range.
 *
 * CDP path: gcal.getEventsList(calendarId, params)
 * MCP fallback: query_email_and_calendar
 */
export async function listEvents(
  provider: ConnectionProvider,
  options?: ListEventsOptions
): Promise<CalendarEvent[]> {
  // --- CDP / SuperhumanProvider path ---
  if (provider instanceof SuperhumanProvider && provider.hasPortal()) {
    try {
      // MS accounts use the MS Graph calendar proxy
      if (await isMicrosoftAccount(provider)) {
        const timeMin = options?.timeMin ? toISOString(options.timeMin) : new Date().toISOString();
        const timeMax = options?.timeMax ? toISOString(options.timeMax) : new Date(Date.now() + 7 * 86400000).toISOString();
        const top = options?.limit || 50;
        const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(timeMin)}&endDateTime=${encodeURIComponent(timeMax)}&$top=${top}&$orderby=start/dateTime`;
        const result = await msCalendarRequest(provider, url, "GET", undefined, "microsoftCalendar.proxy.calendarView");
        const items = result?.value || result || [];
        return Array.isArray(items) ? items.map(normalizeEvent) : [];
      }

      // Google accounts use the gcal DI
      const calendarId = options?.calendarId || "primary";
      const params: Record<string, any> = {
        singleEvents: true,
        orderBy: "startTime",
      };
      if (options?.timeMin) params.timeMin = toISOString(options.timeMin);
      if (options?.timeMax) params.timeMax = toISOString(options.timeMax);
      if (options?.limit) params.maxResults = options.limit;

      const result = await gcalInvoke(provider, "getEventsList", [
        calendarId,
        params,
      ]);

      const items = Array.isArray(result)
        ? result
        : result?.items || result?.events || [];
      return items.map(normalizeEvent);
    } catch (e: any) {
      console.error("listEvents (CDP) error:", e.message);
      return [];
    }
  }

  requirePortal();
}

/**
 * Create a new calendar event.
 *
 * CDP path: gcal.importEvent(accountEmail, eventData)
 */
export async function createEvent(
  provider: ConnectionProvider,
  event: CreateEventInput
): Promise<CalendarResult> {
  // --- CDP / SuperhumanProvider path ---
  if (provider instanceof SuperhumanProvider && provider.hasPortal()) {
    try {
      if (await isMicrosoftAccount(provider)) {
        const data: Record<string, any> = {
          subject: event.summary,
          start: { dateTime: event.start, timeZone: "America/New_York" },
          end: { dateTime: event.end, timeZone: "America/New_York" },
        };
        if (event.description) data.body = { contentType: "text", content: event.description };
        if (event.location) data.location = { displayName: event.location };
        if (event.attendees?.length) {
          data.attendees = event.attendees.map((e) => ({
            emailAddress: { address: e },
            type: "required",
          }));
        }
        const url = "https://graph.microsoft.com/v1.0/me/events";
        const result = await msCalendarRequest(provider, url, "POST", data, "microsoftCalendar.proxy.events.create");
        return { success: true, eventId: result?.id };
      }

      const email = await provider.getCurrentEmail();
      const eventData: Record<string, any> = {
        summary: event.summary,
        start: { dateTime: event.start },
        end: { dateTime: event.end },
      };
      if (event.description) eventData.description = event.description;
      if (event.location) eventData.location = event.location;
      if (event.attendees?.length) {
        eventData.attendees = event.attendees.map((e) => ({ email: e }));
      }

      const result = await gcalInvoke(provider, "importEvent", [
        email,
        eventData,
      ]);

      return {
        success: true,
        eventId: result?.id || result?.event_id,
      };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  requirePortal();
}

/**
 * Delete a calendar event.
 *
 * CDP path: gcal.deleteEvent(calendarId, eventId)
 */
export async function deleteEvent(
  provider: ConnectionProvider,
  eventId: string,
  calendarId?: string
): Promise<CalendarResult> {
  // --- CDP / SuperhumanProvider path ---
  if (provider instanceof SuperhumanProvider && provider.hasPortal()) {
    try {
      if (await isMicrosoftAccount(provider)) {
        const url = `https://graph.microsoft.com/v1.0/me/events/${eventId}`;
        await msCalendarRequest(provider, url, "DELETE", undefined, "microsoftCalendar.proxy.events.delete");
        return { success: true };
      }
      const cid = calendarId || "primary";
      await gcalInvoke(provider, "deleteEvent", [cid, eventId]);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  requirePortal();
}

/**
 * Update an existing calendar event.
 *
 * CDP path: gcal.patchEvent(calendarId, eventId, data)
 */
export async function updateEvent(
  provider: ConnectionProvider,
  eventId: string,
  updates: UpdateEventInput,
  calendarId?: string
): Promise<CalendarResult> {
  // --- CDP / SuperhumanProvider path ---
  if (provider instanceof SuperhumanProvider && provider.hasPortal()) {
    try {
      if (await isMicrosoftAccount(provider)) {
        const data: Record<string, any> = {};
        if (updates.summary) data.subject = updates.summary;
        if (updates.start) data.start = { dateTime: updates.start, timeZone: "America/New_York" };
        if (updates.end) data.end = { dateTime: updates.end, timeZone: "America/New_York" };
        if (updates.description) data.body = { contentType: "text", content: updates.description };
        if (updates.location) data.location = { displayName: updates.location };
        if (updates.attendees?.length) {
          data.attendees = updates.attendees.map((e) => ({
            emailAddress: { address: e },
            type: "required",
          }));
        }
        const url = `https://graph.microsoft.com/v1.0/me/events/${eventId}`;
        await msCalendarRequest(provider, url, "PATCH", data, "microsoftCalendar.proxy.events.update");
        return { success: true, eventId };
      }

      const cid = calendarId || "primary";
      const data: Record<string, any> = {};
      if (updates.summary) data.summary = updates.summary;
      if (updates.start) data.start = { dateTime: updates.start };
      if (updates.end) data.end = { dateTime: updates.end };
      if (updates.description) data.description = updates.description;
      if (updates.location) data.location = updates.location;
      if (updates.attendees?.length) {
        data.attendees = updates.attendees.map((e) => ({ email: e }));
      }

      const result = await gcalInvoke(provider, "patchEvent", [
        cid,
        eventId,
        data,
      ]);
      return {
        success: true,
        eventId: result?.id || eventId,
      };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  requirePortal();
}

/**
 * Check free/busy availability for a time range.
 *
 * CDP path: gcal.queryFreeBusy(params)
 */
export async function getFreeBusy(
  provider: ConnectionProvider,
  options: FreeBusyOptions
): Promise<FreeBusyResult> {
  // --- CDP / SuperhumanProvider path ---
  if (provider instanceof SuperhumanProvider && provider.hasPortal()) {
    try {
      const params: Record<string, any> = {
        timeMin: toISOString(options.timeMin),
        timeMax: toISOString(options.timeMax),
      };
      if (options.calendarIds?.length) {
        params.items = options.calendarIds.map((id) => ({ id }));
      }

      const result = await gcalInvoke(provider, "queryFreeBusy", [params]);

      // queryFreeBusy typically returns { calendars: { <id>: { busy: [...] } } }
      const calendars = result?.calendars || {};
      const allBusy: FreeBusySlot[] = [];
      for (const cal of Object.values(calendars) as any[]) {
        for (const slot of cal.busy || []) {
          allBusy.push({
            start: slot.start || "",
            end: slot.end || "",
          });
        }
      }

      return { busy: allBusy, free: [] };
    } catch (e: any) {
      console.error("getFreeBusy (CDP gcal) error:", e.message);
      return { busy: [], free: [] };
    }
  }

  requirePortal();
}
