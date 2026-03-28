/**
 * Calendar Module
 *
 * Functions for calendar operations via direct Google Calendar/MS Graph API.
 * Supports both Google Calendar and Microsoft Graph accounts.
 */

import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider, getMcpText } from "./mcp-provider";
import {
  type CalendarEventDirect as CalendarEvent,
  type CreateCalendarEventInput as CreateEventInput,
  type UpdateCalendarEventInput as UpdateEventInput,
  type FreeBusySlot,
  listCalendarEventsDirect,
  createCalendarEventDirect,
  updateCalendarEventDirect,
  deleteCalendarEventDirect,
  getFreeBusyDirect,
} from "./token-api";

// Re-export the calendar event type for external use
export type { CalendarEvent };

/**
 * Result of a calendar operation (create, update, delete)
 */
export interface CalendarResult {
  success: boolean;
  eventId?: string;
  error?: string;
}

// Re-export types for external use
export type { FreeBusySlot, CreateEventInput, UpdateEventInput };

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
 * List calendar events within a time range
 *
 * @param provider - The connection provider
 * @param options - Optional filters for time range and limit
 * @returns Array of calendar events
 */
export async function listEvents(
  provider: ConnectionProvider,
  options?: ListEventsOptions
): Promise<CalendarEvent[]> {
  // MCP: use query_email_and_calendar for calendar listing
  if (provider instanceof McpConnectionProvider) {
    try {
      const toISOString = (v: Date | string): string =>
        typeof v === "string" ? v : v.toISOString();

      const args: Record<string, unknown> = {
        query: "calendar events",
      };
      if (options?.timeMin) args.start_date = toISOString(options.timeMin);
      if (options?.timeMax) args.end_date = toISOString(options.timeMax);
      if (options?.limit) args.limit = options.limit;

      const result = await provider.callTool("query_email_and_calendar", args);
      const text = getMcpText(result);
      // Parse MCP response into CalendarEvent format
      try {
        const json = JSON.parse(text);
        const events = Array.isArray(json) ? json : (json.events || []);
        return events.map((e: any) => ({
          id: e.id || e.event_id || "",
          summary: e.summary || e.title || e.subject || "",
          description: e.description || "",
          start: e.start || e.start_time || "",
          end: e.end || e.end_time || "",
          location: e.location || "",
          attendees: e.attendees || [],
          organizer: e.organizer || "",
          isAllDay: e.is_all_day || e.allDay || false,
          status: e.status || "",
          calendarId: e.calendar_id || "",
        }));
      } catch {
        return [];
      }
    } catch (e: any) {
      console.error("listEvents (MCP) error:", e.message);
      return [];
    }
  }

  try {
    const token = await provider.getToken();

    const toISOString = (v: Date | string): string =>
      typeof v === "string" ? v : v.toISOString();

    return await listCalendarEventsDirect(token, {
      calendarId: options?.calendarId,
      timeMin: options?.timeMin ? toISOString(options.timeMin) : undefined,
      timeMax: options?.timeMax ? toISOString(options.timeMax) : undefined,
      limit: options?.limit,
    });
  } catch (e: any) {
    console.error("listEvents error:", e.message);
    return [];
  }
}

/**
 * Create a new calendar event
 *
 * @param provider - The connection provider
 * @param event - The event data to create
 * @returns Result with success status and eventId if successful
 */
export async function createEvent(
  provider: ConnectionProvider,
  event: CreateEventInput
): Promise<CalendarResult> {
  // MCP: use create_or_update_event
  if (provider instanceof McpConnectionProvider) {
    try {
      const args: Record<string, unknown> = {
        title: event.summary,
        start_time: event.start,
        end_time: event.end,
      };
      if (event.description) args.description = event.description;
      if (event.location) args.location = event.location;
      if (event.attendees?.length) args.attendees = event.attendees;

      const result = await provider.callTool("create_or_update_event", args);
      const text = getMcpText(result);
      try {
        const json = JSON.parse(text);
        return { success: true, eventId: json.event_id || json.id };
      } catch {
        return { success: !result.isError };
      }
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  try {
    const token = await provider.getToken();
    const result = await createCalendarEventDirect(token, event);

    if (!result) {
      return { success: false, error: "Failed to create event" };
    }

    return { success: true, eventId: result.eventId };
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

/**
 * Delete a calendar event
 *
 * @param provider - The connection provider
 * @param eventId - The ID of the event to delete
 * @param calendarId - Optional calendar ID (required for Google Calendar)
 * @returns Result with success status
 */
export async function deleteEvent(
  provider: ConnectionProvider,
  eventId: string,
  calendarId?: string
): Promise<CalendarResult> {
  // MCP: use delete_calendar_event (not in the 10 tools list — but we can
  // try create_or_update_event with a cancel/delete action)
  // Note: The MCP server doesn't expose a direct delete — this falls through
  // to the direct API path. MCP users would need CDP fallback for this.

  try {
    const token = await provider.getToken();

    const success = await deleteCalendarEventDirect(token, eventId, calendarId);

    if (!success) {
      return { success: false, error: "Failed to delete event" };
    }

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

/**
 * Update an existing calendar event
 *
 * @param provider - The connection provider
 * @param eventId - The ID of the event to update
 * @param updates - The fields to update (partial update)
 * @param calendarId - Optional calendar ID (required for Google Calendar)
 * @returns Result with success status
 */
export async function updateEvent(
  provider: ConnectionProvider,
  eventId: string,
  updates: UpdateEventInput,
  calendarId?: string
): Promise<CalendarResult> {
  try {
    const token = await provider.getToken();
    const success = await updateCalendarEventDirect(token, eventId, updates, calendarId);

    if (!success) {
      return { success: false, error: "Failed to update event" };
    }

    return { success: true, eventId };
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

/**
 * Options for checking free/busy availability
 */
export interface FreeBusyOptions {
  timeMin: Date | string;
  timeMax: Date | string;
  calendarIds?: string[]; // Optional: specific calendars to check
}

/**
 * Check free/busy availability for a time range
 *
 * @param provider - The connection provider
 * @param options - Time range and optional calendar IDs
 * @returns Free/busy slots
 */
export async function getFreeBusy(
  provider: ConnectionProvider,
  options: FreeBusyOptions
): Promise<FreeBusyResult> {
  // MCP: use get_availability_calendar
  if (provider instanceof McpConnectionProvider) {
    try {
      const toISOString = (v: Date | string): string =>
        typeof v === "string" ? v : v.toISOString();

      const result = await provider.callTool("get_availability_calendar", {
        start_time: toISOString(options.timeMin),
        end_time: toISOString(options.timeMax),
        attendees: options.calendarIds || [],
      });
      const text = getMcpText(result);
      try {
        const json = JSON.parse(text);
        return {
          busy: (json.busy || []).map((s: any) => ({
            start: s.start || s.start_time || "",
            end: s.end || s.end_time || "",
          })),
          free: (json.free || json.available || []).map((s: any) => ({
            start: s.start || s.start_time || "",
            end: s.end || s.end_time || "",
          })),
        };
      } catch {
        return { busy: [], free: [] };
      }
    } catch (e: any) {
      console.error("getFreeBusy (MCP) error:", e.message);
      return { busy: [], free: [] };
    }
  }

  try {
    const token = await provider.getToken();

    const toISOString = (v: Date | string): string =>
      typeof v === "string" ? v : v.toISOString();

    const busy = await getFreeBusyDirect(
      token,
      toISOString(options.timeMin),
      toISOString(options.timeMax),
      options.calendarIds
    );

    return { busy, free: [] };
  } catch (e: any) {
    console.error("getFreeBusy error:", e.message);
    return { busy: [], free: [] };
  }
}
