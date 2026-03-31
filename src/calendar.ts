/**
 * Calendar Module
 *
 * Functions for calendar operations via MCP provider.
 * Provider-specific OAuth (Google Calendar/MS Graph) has been removed.
 */

import type { ConnectionProvider } from "./connection-provider";
import { getMcpText } from "./mcp-provider";
import { requireMcp } from "./mcp-guard";

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
 * List calendar events within a time range
 *
 * @param provider - The connection provider (must be MCP)
 * @param options - Optional filters for time range and limit
 * @returns Array of calendar events
 */
export async function listEvents(
  provider: ConnectionProvider,
  options?: ListEventsOptions
): Promise<CalendarEvent[]> {
  const mcp = requireMcp(provider);

  try {
    const toISOString = (v: Date | string): string =>
      typeof v === "string" ? v : v.toISOString();

    // Build a natural language question for the MCP tool
    const parts = ["List my calendar events"];
    if (options?.timeMin) parts.push(`from ${toISOString(options.timeMin)}`);
    if (options?.timeMax) parts.push(`until ${toISOString(options.timeMax)}`);
    if (options?.limit) parts.push(`(limit ${options.limit})`);

    const result = await mcp.callTool("query_email_and_calendar", {
      question: parts.join(" "),
    });
    const text = getMcpText(result);
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

/**
 * Create a new calendar event
 *
 * @param provider - The connection provider (must be MCP)
 * @param event - The event data to create
 * @returns Result with success status and eventId if successful
 */
export async function createEvent(
  provider: ConnectionProvider,
  event: CreateEventInput
): Promise<CalendarResult> {
  const mcp = requireMcp(provider);

  try {
    const args: Record<string, unknown> = {
      summary: event.summary,
      start: event.start,
      end: event.end,
    };
    if (event.description) args.description = event.description;
    if (event.location) args.location = event.location;
    if (event.attendees?.length) args.attendees = event.attendees;

    const result = await mcp.callTool("create_or_update_event", args);
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

/**
 * Delete a calendar event
 *
 * @param provider - The connection provider (must be MCP)
 * @param eventId - The ID of the event to delete
 * @param calendarId - Optional calendar ID
 * @returns Result with success status
 */
export async function deleteEvent(
  provider: ConnectionProvider,
  eventId: string,
  calendarId?: string
): Promise<CalendarResult> {
  const mcp = requireMcp(provider);

  // The MCP server doesn't expose a direct delete tool.
  // Attempt via create_or_update_event with a cancel status.
  try {
    const args: Record<string, unknown> = {
      event_id: eventId,
      status: "cancelled",
    };
    if (calendarId) args.calendar_id = calendarId;

    const result = await mcp.callTool("create_or_update_event", args);
    return { success: !result.isError };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Update an existing calendar event
 *
 * @param provider - The connection provider (must be MCP)
 * @param eventId - The ID of the event to update
 * @param updates - The fields to update (partial update)
 * @param calendarId - Optional calendar ID
 * @returns Result with success status
 */
export async function updateEvent(
  provider: ConnectionProvider,
  eventId: string,
  updates: UpdateEventInput,
  calendarId?: string
): Promise<CalendarResult> {
  const mcp = requireMcp(provider);

  try {
    const args: Record<string, unknown> = { event_id: eventId };
    if (updates.summary) args.summary = updates.summary;
    if (updates.start) args.start = updates.start;
    if (updates.end) args.end = updates.end;
    if (updates.description) args.description = updates.description;
    if (updates.location) args.location = updates.location;
    if (updates.attendees?.length) args.attendees = updates.attendees;
    if (calendarId) args.calendar_id = calendarId;

    const result = await mcp.callTool("create_or_update_event", args);
    const text = getMcpText(result);
    try {
      const json = JSON.parse(text);
      return { success: true, eventId: json.event_id || json.id || eventId };
    } catch {
      return { success: !result.isError, eventId };
    }
  } catch (e: any) {
    return { success: false, error: e.message };
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
 * @param provider - The connection provider (must be MCP)
 * @param options - Time range and optional calendar IDs
 * @returns Free/busy slots
 */
export async function getFreeBusy(
  provider: ConnectionProvider,
  options: FreeBusyOptions
): Promise<FreeBusyResult> {
  const mcp = requireMcp(provider);

  try {
    const result = await mcp.callTool("get_availability_calendar", {
      participants: options.calendarIds || [],
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
