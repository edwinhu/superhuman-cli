/**
 * Calendar Module
 *
 * Functions for calendar operations via Superhuman's internal APIs.
 * Supports both Google Calendar (gcal) and Microsoft Graph (msgraph) accounts.
 */

import type { SuperhumanConnection } from "./superhuman-api";

/**
 * Represents a calendar event with fields common to both Google and Microsoft
 */
export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  description?: string;
  start: {
    dateTime?: string;
    date?: string; // for all-day events
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: "needsAction" | "accepted" | "declined" | "tentative";
    organizer?: boolean;
    self?: boolean;
  }>;
  recurrence?: string[]; // RRULE format
  recurringEventId?: string;
  htmlLink?: string;
  conferenceData?: Record<string, unknown>;
  status?: "confirmed" | "tentative" | "cancelled";
  visibility?: "default" | "public" | "private";
  allDay?: boolean;
  isOrganizer?: boolean;
  provider?: "google" | "microsoft";
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
 * Represents a busy time slot
 */
export interface FreeBusySlot {
  start: string;
  end: string;
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
  calendarId?: string; // Optional: specific calendar to list from
  timeMin?: Date | string;
  timeMax?: Date | string;
  limit?: number;
}

/**
 * Input for creating a calendar event
 */
export interface CreateEventInput {
  calendarId?: string; // Optional: specific calendar to create in
  summary: string;
  description?: string;
  start: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  attendees?: Array<{ email: string; displayName?: string }>;
  recurrence?: string[];
  location?: string;
}

/**
 * Input for updating a calendar event (partial update)
 */
export interface UpdateEventInput {
  summary?: string;
  description?: string;
  start?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  attendees?: Array<{ email: string; displayName?: string }>;
  recurrence?: string[];
  location?: string;
}

/**
 * List calendar events within a time range
 *
 * @param conn - The Superhuman connection
 * @param options - Optional filters for time range and limit
 * @returns Array of calendar events
 */
export async function listEvents(
  conn: SuperhumanConnection,
  options?: ListEventsOptions
): Promise<CalendarEvent[]> {
  const { Runtime } = conn;

  // Default to today + 7 days if no time range specified
  const now = new Date();
  const timeMin = options?.timeMin
    ? (typeof options.timeMin === "string" ? options.timeMin : options.timeMin.toISOString())
    : now.toISOString();
  const timeMax = options?.timeMax
    ? (typeof options.timeMax === "string" ? options.timeMax : options.timeMax.toISOString())
    : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const timeMin = ${JSON.stringify(timeMin)};
          const timeMax = ${JSON.stringify(timeMax)};
          const calendarIdOption = ${JSON.stringify(options?.calendarId || null)};
          const ga = window.GoogleAccount;
          const di = ga?.di;

          if (!di) {
            return { error: "DI container not found", events: [] };
          }

          const isMicrosoft = di.get?.('isMicrosoft');

          if (isMicrosoft) {
            // Microsoft Graph: use calendarView
            const msgraph = di.get?.('msgraph');
            if (!msgraph?.calendarView) {
              return { error: "msgraph.calendarView not found", events: [] };
            }

            const accountEmail = ga?.emailAddress;

            // Get primary calendar ID
            let calendarId = calendarIdOption || 'primary';
            if (calendarId === 'primary') {
              try {
                const calendars = await msgraph.getCalendars(accountEmail);
                const primaryCal = calendars?.find(c => c.isDefaultCalendar) || calendars?.[0];
                if (primaryCal?.id) calendarId = primaryCal.id;
              } catch {}
            }

            try {
              // calendarView(calendarId, accountEmail, {start, end})
              const msEvents = await msgraph.calendarView(
                calendarId,
                accountEmail,
                { start: new Date(timeMin), end: new Date(timeMax) }
              );
              const events = (msEvents || []).map(e => ({
                id: e.id,
                calendarId: e.calendar?.id || 'primary',
                summary: e.subject || '',
                description: e.bodyPreview || e.body?.content || '',
                start: {
                  dateTime: e.start?.dateTime,
                  timeZone: e.start?.timeZone,
                  date: e.isAllDay ? e.start?.dateTime?.split('T')[0] : undefined
                },
                end: {
                  dateTime: e.end?.dateTime,
                  timeZone: e.end?.timeZone,
                  date: e.isAllDay ? e.end?.dateTime?.split('T')[0] : undefined
                },
                attendees: (e.attendees || []).map(a => ({
                  email: a.emailAddress?.address || '',
                  displayName: a.emailAddress?.name || '',
                  responseStatus: a.status?.response || 'needsAction',
                  organizer: a.type === 'required' && e.organizer?.emailAddress?.address === a.emailAddress?.address
                })),
                recurrence: e.recurrence ? [JSON.stringify(e.recurrence)] : undefined,
                recurringEventId: e.seriesMasterId,
                htmlLink: e.webLink,
                conferenceData: e.onlineMeeting,
                status: e.isCancelled ? 'cancelled' : 'confirmed',
                allDay: e.isAllDay,
                isOrganizer: e.isOrganizer,
                provider: 'microsoft'
              }));
              return { events };
            } catch (e) {
              return { error: e.message, events: [] };
            }
          } else {
            // Google Calendar: use gcal.getEventsList
            const gcal = di.get?.('gcal');
            if (!gcal?.getEventsList) {
              return { error: "gcal.getEventsList not found", events: [] };
            }

            const accountEmail = ga?.emailAddress || 'primary';
            const calendarId = calendarIdOption || accountEmail;

            try {
              // Correct signature: getEventsList({calendarId, calendarAccountEmail}, options)
              const gcalEvents = await gcal.getEventsList(
                { calendarId, calendarAccountEmail: accountEmail },
                { timeMin, timeMax, singleEvents: true, orderBy: 'startTime' }
              );

              const events = (gcalEvents?.items || gcalEvents || []).map(e => ({
                id: e.id,
                calendarId: e.calendarId || accountEmail,
                summary: e.summary || '',
                description: e.description || '',
                start: {
                  dateTime: e.start?.dateTime || e.rawStart?.dateTime,
                  date: e.start?.date,
                  timeZone: e.start?.timeZone || e.rawStart?.timeZone
                },
                end: {
                  dateTime: e.end?.dateTime || e.rawEnd?.dateTime,
                  date: e.end?.date,
                  timeZone: e.end?.timeZone || e.rawEnd?.timeZone
                },
                attendees: (e.attendees || []).map(a => ({
                  email: a.email || '',
                  displayName: a.displayName || '',
                  responseStatus: a.responseStatus || 'needsAction',
                  organizer: a.organizer,
                  self: a.self
                })),
                recurrence: e.recurrence,
                recurringEventId: e.recurringEventId,
                htmlLink: e.htmlLink,
                conferenceData: e.conferenceData,
                status: e.status || 'confirmed',
                visibility: e.visibility,
                allDay: !!e.start?.date || e.allDay,
                isOrganizer: e.isOrganizer,
                provider: 'google'
              }));
              return { events };
            } catch (e) {
              return { error: e.message, events: [] };
            }
          }
        } catch (e) {
          return { error: e.message || "Unknown error", events: [] };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  const value = result.result.value as { events: CalendarEvent[]; error?: string } | null;
  return value?.events ?? [];
}

/**
 * Create a new calendar event
 *
 * @param conn - The Superhuman connection
 * @param event - The event data to create
 * @returns Result with success status and eventId if successful
 */
export async function createEvent(
  conn: SuperhumanConnection,
  event: CreateEventInput
): Promise<CalendarResult> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const eventData = ${JSON.stringify(event)};
          const ga = window.GoogleAccount;
          const di = ga?.di;

          if (!di) {
            return { success: false, error: "DI container not found" };
          }

          const isMicrosoft = di.get?.('isMicrosoft');

          if (isMicrosoft) {
            // Microsoft Graph: use _fetchJSONWithRetry to POST to events endpoint
            const msgraph = di.get?.('msgraph');
            if (!msgraph?._fetchJSONWithRetry) {
              return { success: false, error: "msgraph._fetchJSONWithRetry not found" };
            }

            const accountEmail = ga?.emailAddress;

            // Get calendar ID (default to primary)
            let calendarId = eventData.calendarId || null;
            if (!calendarId) {
              try {
                const calendars = await msgraph.getCalendars(accountEmail);
                const primaryCal = calendars?.find(c => c.isDefaultCalendar) || calendars?.[0];
                if (primaryCal?.id) calendarId = primaryCal.id;
              } catch {}
            }

            if (!calendarId) {
              return { success: false, error: "Could not get calendar ID" };
            }

            const msEvent = {
              subject: eventData.summary,
              body: eventData.description ? { contentType: 'text', content: eventData.description } : undefined,
              start: {
                dateTime: eventData.start.dateTime || eventData.start.date + 'T00:00:00',
                timeZone: eventData.start.timeZone || 'UTC'
              },
              end: {
                dateTime: eventData.end.dateTime || eventData.end.date + 'T23:59:59',
                timeZone: eventData.end.timeZone || 'UTC'
              },
              attendees: (eventData.attendees || []).map(a => ({
                emailAddress: { address: a.email, name: a.displayName || '' },
                type: 'required'
              })),
              location: eventData.location ? { displayName: eventData.location } : undefined
            };

            try {
              // POST directly to events endpoint using _fetchJSONWithRetry (without proxy flag)
              const url = msgraph._fullURL('/v1.0/me/calendars/' + calendarId + '/events', {});
              const created = await msgraph._fetchJSONWithRetry(url, {
                method: 'POST',
                body: JSON.stringify(msEvent),
                headers: { 'Content-Type': 'application/json' },
                endpoint: 'events.create'
              });
              return { success: true, eventId: created?.id };
            } catch (e) {
              return { success: false, error: e.message };
            }
          } else {
            // Google Calendar: use gcal._postAsync to create event
            const gcal = di.get?.('gcal');
            if (!gcal?._postAsync) {
              return { success: false, error: "gcal._postAsync not found" };
            }

            const accountEmail = ga?.emailAddress || 'primary';
            const calendarId = eventData.calendarId || accountEmail;

            const gcalEvent = {
              summary: eventData.summary,
              description: eventData.description,
              start: eventData.start,
              end: eventData.end,
              attendees: (eventData.attendees || []).map(a => ({
                email: a.email,
                displayName: a.displayName
              })),
              recurrence: eventData.recurrence,
              location: eventData.location
            };

            try {
              // Use _postAsync to POST to /events endpoint
              const url = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events';
              const created = await gcal._postAsync(url, gcalEvent, {
                calendarAccountEmail: accountEmail,
                endpoint: 'gcal.events.insert'
              });
              return { success: true, eventId: created?.id };
            } catch (e) {
              return { success: false, error: e.message };
            }
          }
        } catch (e) {
          return { success: false, error: e.message || "Unknown error" };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  const value = result.result.value as CalendarResult | null;
  return {
    success: value?.success ?? false,
    eventId: value?.eventId,
    error: value?.error,
  };
}

/**
 * Delete a calendar event
 *
 * @param conn - The Superhuman connection
 * @param eventId - The ID of the event to delete
 * @returns Result with success status
 */
export async function deleteEvent(
  conn: SuperhumanConnection,
  eventId: string
): Promise<CalendarResult> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const eventId = ${JSON.stringify(eventId)};
          const ga = window.GoogleAccount;
          const di = ga?.di;

          if (!di) {
            return { success: false, error: "DI container not found" };
          }

          const isMicrosoft = di.get?.('isMicrosoft');

          if (isMicrosoft) {
            const msgraph = di.get?.('msgraph');
            if (!msgraph?.deleteEvent) {
              return { success: false, error: "msgraph.deleteEvent not found" };
            }

            const accountEmail = ga?.emailAddress;

            try {
              // deleteEvent(event, calendarAccount, comment, recurringEventId)
              await msgraph.deleteEvent(
                { id: eventId, accountEmail },
                accountEmail,
                null,  // comment
                null   // recurringEventId
              );
              return { success: true };
            } catch (e) {
              return { success: false, error: e.message };
            }
          } else {
            const gcal = di.get?.('gcal');
            if (!gcal?.deleteEvent) {
              return { success: false, error: "gcal.deleteEvent not found" };
            }

            const accountEmail = ga?.emailAddress || 'primary';

            try {
              await gcal.deleteEvent(
                { calendarId: accountEmail, calendarAccountEmail: accountEmail },
                eventId
              );
              return { success: true };
            } catch (e) {
              return { success: false, error: e.message };
            }
          }
        } catch (e) {
          return { success: false, error: e.message || "Unknown error" };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  const value = result.result.value as CalendarResult | null;
  return {
    success: value?.success ?? false,
    error: value?.error,
  };
}

/**
 * Update an existing calendar event
 *
 * @param conn - The Superhuman connection
 * @param eventId - The ID of the event to update
 * @param updates - The fields to update (partial update)
 * @returns Result with success status
 */
export async function updateEvent(
  conn: SuperhumanConnection,
  eventId: string,
  updates: UpdateEventInput
): Promise<CalendarResult> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const eventId = ${JSON.stringify(eventId)};
          const updates = ${JSON.stringify(updates)};
          const ga = window.GoogleAccount;
          const di = ga?.di;

          if (!di) {
            return { success: false, error: "DI container not found" };
          }

          const isMicrosoft = di.get?.('isMicrosoft');

          if (isMicrosoft) {
            const msgraph = di.get?.('msgraph');
            if (!msgraph?.updateEvent) {
              return { success: false, error: "msgraph.updateEvent not found" };
            }

            const accountEmail = ga?.emailAddress;

            // Get primary calendar ID
            let calendarId = 'primary';
            try {
              const calendars = await msgraph.getCalendars(accountEmail);
              const primaryCal = calendars?.find(c => c.isDefaultCalendar) || calendars?.[0];
              if (primaryCal?.id) calendarId = primaryCal.id;
            } catch {}

            // Transform to Microsoft Graph format
            const msUpdate = {};
            if (updates.summary) msUpdate.subject = updates.summary;
            if (updates.description) msUpdate.body = { contentType: 'text', content: updates.description };
            if (updates.start) {
              msUpdate.start = {
                dateTime: updates.start.dateTime || updates.start.date + 'T00:00:00',
                timeZone: updates.start.timeZone || 'UTC'
              };
            }
            if (updates.end) {
              msUpdate.end = {
                dateTime: updates.end.dateTime || updates.end.date + 'T23:59:59',
                timeZone: updates.end.timeZone || 'UTC'
              };
            }
            if (updates.attendees) {
              msUpdate.attendees = updates.attendees.map(a => ({
                emailAddress: { address: a.email, name: a.displayName || '' },
                type: 'required'
              }));
            }
            if (updates.location) msUpdate.location = { displayName: updates.location };

            try {
              // updateEvent({calendarId, eventId, updates, calendarAccount})
              await msgraph.updateEvent({
                calendarId,
                eventId,
                updates: msUpdate,
                calendarAccount: accountEmail
              });
              return { success: true, eventId };
            } catch (e) {
              return { success: false, error: e.message };
            }
          } else {
            const gcal = di.get?.('gcal');
            if (!gcal?.patchEvent) {
              return { success: false, error: "gcal.patchEvent not found" };
            }

            const accountEmail = ga?.emailAddress || 'primary';

            // Transform to Google Calendar format
            const gcalPatch = {};
            if (updates.summary) gcalPatch.summary = updates.summary;
            if (updates.description) gcalPatch.description = updates.description;
            if (updates.start) gcalPatch.start = updates.start;
            if (updates.end) gcalPatch.end = updates.end;
            if (updates.attendees) {
              gcalPatch.attendees = updates.attendees.map(a => ({
                email: a.email,
                displayName: a.displayName
              }));
            }
            if (updates.recurrence) gcalPatch.recurrence = updates.recurrence;
            if (updates.location) gcalPatch.location = updates.location;

            try {
              await gcal.patchEvent(
                { calendarId: accountEmail, calendarAccountEmail: accountEmail },
                eventId,
                gcalPatch
              );
              return { success: true, eventId };
            } catch (e) {
              return { success: false, error: e.message };
            }
          }
        } catch (e) {
          return { success: false, error: e.message || "Unknown error" };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  const value = result.result.value as CalendarResult | null;
  return {
    success: value?.success ?? false,
    eventId: value?.eventId,
    error: value?.error,
  };
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
 * @param conn - The Superhuman connection
 * @param options - Time range and optional calendar IDs
 * @returns Free/busy slots
 */
export async function getFreeBusy(
  conn: SuperhumanConnection,
  options: FreeBusyOptions
): Promise<FreeBusyResult> {
  const { Runtime } = conn;

  const timeMin = typeof options.timeMin === "string"
    ? options.timeMin
    : options.timeMin.toISOString();
  const timeMax = typeof options.timeMax === "string"
    ? options.timeMax
    : options.timeMax.toISOString();

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const timeMin = ${JSON.stringify(timeMin)};
          const timeMax = ${JSON.stringify(timeMax)};
          const calendarIds = ${JSON.stringify(options.calendarIds || null)};
          const ga = window.GoogleAccount;
          const di = ga?.di;

          if (!di) {
            return { error: "DI container not found", busy: [], free: [] };
          }

          const isMicrosoft = di.get?.('isMicrosoft');

          if (isMicrosoft) {
            const msgraph = di.get?.('msgraph');
            if (!msgraph?.fetchTeamAvailability) {
              // Fallback: use calendarView to derive busy times
              if (!msgraph?.calendarView) {
                return { error: "msgraph availability methods not found", busy: [], free: [] };
              }

              try {
                const events = await msgraph.calendarView(timeMin, timeMax);
                const busy = (events || [])
                  .filter(e => !e.isCancelled && e.showAs !== 'free')
                  .map(e => ({
                    start: e.start?.dateTime,
                    end: e.end?.dateTime
                  }));
                return { busy, free: [] };
              } catch (e) {
                return { error: e.message, busy: [], free: [] };
              }
            }

            try {
              const availability = await msgraph.fetchTeamAvailability(
                calendarIds || [],
                timeMin,
                timeMax
              );
              // Transform Microsoft availability to our format
              const busy = [];
              for (const schedule of (availability?.value || [])) {
                for (const item of (schedule.scheduleItems || [])) {
                  if (item.status !== 'free') {
                    busy.push({ start: item.start?.dateTime, end: item.end?.dateTime });
                  }
                }
              }
              return { busy, free: [] };
            } catch (e) {
              return { error: e.message, busy: [], free: [] };
            }
          } else {
            const gcal = di.get?.('gcal');
            if (!gcal?.queryFreeBusy) {
              return { error: "gcal.queryFreeBusy not found", busy: [], free: [] };
            }

            const accountEmail = ga?.emailAddress || 'primary';
            const items = calendarIds
              ? calendarIds.map(id => ({ id }))
              : [{ id: accountEmail }];

            try {
              const freeBusy = await gcal.queryFreeBusy({
                timeMin,
                timeMax,
                items
              });

              // Extract busy times from response
              const busy = [];
              const calendars = freeBusy?.calendars || {};
              for (const calId of Object.keys(calendars)) {
                for (const slot of (calendars[calId].busy || [])) {
                  busy.push({ start: slot.start, end: slot.end });
                }
              }

              return { busy, free: [] };
            } catch (e) {
              return { error: e.message, busy: [], free: [] };
            }
          }
        } catch (e) {
          return { error: e.message || "Unknown error", busy: [], free: [] };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  const value = result.result.value as FreeBusyResult & { error?: string } | null;
  return {
    busy: value?.busy ?? [],
    free: value?.free ?? [],
  };
}
