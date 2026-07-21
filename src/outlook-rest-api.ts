/**
 * Outlook Web (OWA) REST API client + per-verb data functions.
 *
 * Talks to the Outlook REST API v2.0 (base https://outlook.office.com/api/v2.0/me)
 * using the first-party OWA session token brokered by owa-token.ts (aud =
 * https://outlook.office.com, Mail.ReadWrite / Mail.Send scopes). This is the
 * no-consent path for Microsoft accounts on tenants (e.g. UVA) that gate
 * third-party mail apps behind admin consent.
 *
 * Each data function returns the SAME JSON shape the Superhuman path returns
 * (InboxThread, ThreadMessage, StarredThread, Label, CalendarEvent, Attachment,
 * Contact, Draft) so the CLI's output contracts — parsed by the email-handling
 * skill — are identical regardless of backend.
 *
 * The low-level `owaFetch(token, method, path, body?)` is the only thing that
 * touches the network. Data functions receive an `OwaFetcher` (a bound
 * `owaFetch`) so unit tests can inject a mock returning raw OWA REST fixtures
 * and assert both the emitted shape AND the REST path/method/body.
 */

import type { InboxThread } from "./inbox";
import type { ThreadMessage } from "./read";
import type { Label, StarredThread } from "./labels";
import type { CalendarEvent } from "./calendar";
import type { Attachment } from "./attachments";
import type { Contact } from "./contacts";
import type { Draft } from "./services/draft-service";

/** Outlook REST v2.0 base for the signed-in user. */
export const OWA_REST_BASE = "https://outlook.office.com/api/v2.0/me";

/**
 * A bound `owaFetch` — the seam data functions call. The provider supplies one
 * that fetches a fresh token first; tests supply a mock returning fixtures.
 */
export type OwaFetcher = (
  method: string,
  path: string,
  body?: any
) => Promise<any>;

/**
 * Low-level Outlook REST call. Bearer auth, JSON in/out. Returns parsed JSON,
 * or null for 204 (no content). Throws on !ok with status + body. Never logs
 * the token.
 */
export async function owaFetch(
  token: string,
  method: string,
  path: string,
  body?: any
): Promise<any> {
  const url = path.startsWith("http") ? path : `${OWA_REST_BASE}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (resp.status === 204) return null;

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Outlook REST error: ${resp.status} ${resp.statusText} — ${method} ${path} ${text.slice(0, 500)}`
    );
  }

  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Fetch raw (non-JSON) bytes from an Outlook REST path — used for `$value`
 * (RFC822 MIME) exports. Bearer auth; throws on !ok.
 */
export async function owaFetchRaw(token: string, path: string): Promise<Uint8Array> {
  const url = path.startsWith("http") ? path : `${OWA_REST_BASE}${path}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Outlook REST error: ${resp.status} ${resp.statusText} — GET ${path} ${text.slice(0, 300)}`
    );
  }
  return new Uint8Array(await resp.arrayBuffer());
}

/** Build a bound fetcher for a concrete access token. */
export function makeOwaFetcher(token: string): OwaFetcher {
  return (method, path, body) => owaFetch(token, method, path, body);
}

// ---------------------------------------------------------------------------
// Shape helpers — map Outlook REST (PascalCase) → superhuman JSON contracts
// ---------------------------------------------------------------------------

/** Fields selected for a message list row (no body). */
const MSG_SELECT =
  "Id,Subject,From,ToRecipients,CcRecipients,ReceivedDateTime,BodyPreview,ConversationId,IsRead,Flag,Categories,InternetMessageId";

/** Map an Outlook Recipient / EmailAddress to {email,name}. */
function addr(r: any): { email: string; name: string } {
  const e = r?.EmailAddress ?? r ?? {};
  return { email: e.Address || "", name: e.Name || "" };
}

/** Map an Outlook recipient list to [{email,name}], dropping entries with no email. */
function addrs(list: any): { email: string; name: string }[] {
  if (!Array.isArray(list)) return [];
  return list.map(addr).filter((r) => r.email);
}

/**
 * Derive superhuman-style labelIds from an Outlook message: UNREAD when
 * !IsRead, STARRED when flagged, plus any Categories verbatim.
 */
function labelIdsOf(m: any): string[] {
  const ids: string[] = [];
  if (m?.IsRead === false) ids.push("UNREAD");
  if (m?.Flag?.FlagStatus === "Flagged") ids.push("STARRED");
  if (Array.isArray(m?.Categories)) ids.push(...m.Categories);
  return ids;
}

/** Extract a filename extension (lowercased, no dot). */
function extOf(name: string): string {
  const parts = (name || "").split(".");
  return parts.length > 1 ? parts[parts.length - 1]!.toLowerCase() : "";
}

/** Convert a plain message object into an InboxThread (+ optional body). */
function messageToInboxThread(
  m: any,
  meEmail: string
): InboxThread & { body?: string } {
  const from = addr(m.From);
  const isFromMe =
    from.email !== "" && from.email.toLowerCase() === meEmail.toLowerCase();
  const thread: InboxThread & { body?: string } = {
    id: m.Id || "",
    subject: m.Subject || "",
    from,
    to: addrs(m.ToRecipients),
    cc: addrs(m.CcRecipients),
    date: m.ReceivedDateTime || "",
    snippet: m.BodyPreview || "",
    labelIds: labelIdsOf(m),
    messageCount: 1,
    isFromMe,
    awaitingReply: !isFromMe,
  };
  if (m.Body?.Content !== undefined) thread.body = m.Body.Content;
  return thread;
}

/** Convert a message object into a ThreadMessage (body included when present). */
function messageToThreadMessage(m: any): ThreadMessage {
  return {
    id: m.Id || "",
    threadId: m.ConversationId || "",
    subject: m.Subject || "",
    from: addr(m.From),
    to: addrs(m.ToRecipients),
    cc: addrs(m.CcRecipients),
    date: m.ReceivedDateTime || "",
    snippet: m.BodyPreview || "",
    body: m.Body?.Content || undefined,
  };
}

/** Build an Outlook recipient object list from "Name <email>" / bare-email strings. */
function toRecipientList(items?: string[]): any[] {
  if (!items || items.length === 0) return [];
  return items.map((s) => {
    const m = s.match(/^(.*?)\s*<([^<>]+)>\s*$/);
    if (m) return { EmailAddress: { Name: m[1]!.trim() || undefined, Address: m[2]!.trim() } };
    return { EmailAddress: { Address: s.trim() } };
  });
}

/** Body block for create/patch: HTML unless the caller asked for text. */
function bodyBlock(content: string, html: boolean): any {
  return { ContentType: html ? "HTML" : "Text", Content: content };
}

// ---------------------------------------------------------------------------
// Read verbs
// ---------------------------------------------------------------------------

export interface OwaListInboxOptions {
  limit?: number;
  needsReply?: boolean;
  /** Keep only threads carrying this label (Category name / UNREAD / STARRED). */
  label?: string;
  withBody?: boolean;
}

/** List the inbox (latest messages first). */
export async function owaListInbox(
  fetch: OwaFetcher,
  meEmail: string,
  opts: OwaListInboxOptions = {}
): Promise<(InboxThread & { body?: string })[]> {
  const top = opts.limit ?? 10;
  const select = opts.withBody ? `${MSG_SELECT},Body` : MSG_SELECT;
  const path = `/mailfolders/inbox/messages?$top=${top}&$select=${encodeURIComponent(
    select
  )}&$orderby=${encodeURIComponent("ReceivedDateTime desc")}`;
  const data = await fetch("GET", path);
  let threads: (InboxThread & { body?: string })[] = (data?.value || []).map(
    (m: any) => messageToInboxThread(m, meEmail)
  );

  if (opts.needsReply) threads = threads.filter((t) => !t.isFromMe);
  if (opts.label) {
    const want = opts.label.toLowerCase();
    threads = threads.filter((t) =>
      t.labelIds.some((l) => l.toLowerCase() === want)
    );
  }
  return threads.slice(0, top);
}

export interface OwaSearchOptions {
  limit?: number;
  withBody?: boolean;
}

/** Full-text search across the mailbox via $search. */
export async function owaSearch(
  fetch: OwaFetcher,
  meEmail: string,
  query: string,
  opts: OwaSearchOptions = {}
): Promise<(InboxThread & { body?: string })[]> {
  const top = opts.limit ?? 25;
  const select = opts.withBody ? `${MSG_SELECT},Body` : MSG_SELECT;
  // $search cannot combine with $orderby on Outlook REST; results come ranked.
  const path = `/messages?$top=${top}&$select=${encodeURIComponent(
    select
  )}&$search=${encodeURIComponent(`"${query}"`)}`;
  const data = await fetch("GET", path);
  return (data?.value || []).map((m: any) => messageToInboxThread(m, meEmail));
}

/**
 * Read every message in a thread. Resolves the message's ConversationId, then
 * lists the whole conversation oldest-first with bodies.
 */
export async function owaGetThread(
  fetch: OwaFetcher,
  id: string
): Promise<ThreadMessage[]> {
  // Resolve the conversation id from the passed message id.
  const head = await fetch(
    "GET",
    `/messages/${encodeURIComponent(id)}?$select=ConversationId`
  );
  const cid: string = head?.ConversationId;
  const select = `${MSG_SELECT},Body`;

  if (!cid) {
    // Fall back to the single message when it has no conversation id.
    const one = await fetch(
      "GET",
      `/messages/${encodeURIComponent(id)}?$select=${encodeURIComponent(select)}`
    );
    return one ? [messageToThreadMessage(one)] : [];
  }

  // NOTE: Exchange rejects $filter=ConversationId combined with $orderby
  // ("InefficientFilter", 400) — same constraint the MS Graph path documents.
  // Fetch unsorted, then sort oldest-first client-side.
  const path = `/messages?$filter=${encodeURIComponent(
    `ConversationId eq '${cid}'`
  )}&$select=${encodeURIComponent(select)}&$top=100`;
  const data = await fetch("GET", path);
  const msgs = (data?.value || []).map((m: any) => messageToThreadMessage(m));
  msgs.sort(
    (a: ThreadMessage, b: ThreadMessage) =>
      new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
  );
  return msgs;
}

// ---------------------------------------------------------------------------
// Compose verbs (create draft / reply / forward / send)
// ---------------------------------------------------------------------------

export interface OwaCreateDraftInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  /** true → HTML body (default), false → plain text. */
  html?: boolean;
}

export interface OwaDraftResult {
  id: string;
  threadId?: string;
}

/** Create a draft in the Drafts folder (POST /messages). Returns its Id. */
export async function owaCreateDraft(
  fetch: OwaFetcher,
  input: OwaCreateDraftInput
): Promise<OwaDraftResult> {
  const msg: any = {
    Subject: input.subject || "",
    Body: bodyBlock(input.body || "", input.html !== false),
    ToRecipients: toRecipientList(input.to),
  };
  if (input.cc?.length) msg.CcRecipients = toRecipientList(input.cc);
  if (input.bcc?.length) msg.BccRecipients = toRecipientList(input.bcc);
  const created = await fetch("POST", "/messages", msg);
  return { id: created?.Id || "", threadId: created?.ConversationId };
}

/**
 * Create a reply draft for message `id` (createReply / createReplyAll), then
 * prepend the user's text above Outlook's quoted original. Returns the draft Id.
 */
export async function owaReply(
  fetch: OwaFetcher,
  id: string,
  opts: { body?: string; html?: boolean; all?: boolean }
): Promise<OwaDraftResult> {
  const action = opts.all ? "createReplyAll" : "createReply";
  const draft = await fetch("POST", `/messages/${encodeURIComponent(id)}/${action}`);
  const draftId: string = draft?.Id || "";
  if (opts.body && draftId) {
    const existing: string = draft?.Body?.Content || "";
    const html = opts.html !== false;
    const merged = html
      ? `${opts.body}<br><br>${existing}`
      : `${opts.body}\n\n${existing}`;
    await fetch("PATCH", `/messages/${encodeURIComponent(draftId)}`, {
      Body: bodyBlock(merged, html),
    });
  }
  return { id: draftId, threadId: draft?.ConversationId };
}

/**
 * Create a forward draft for message `id` (createForward), set recipients and
 * prepend the user's note. Returns the draft Id.
 */
export async function owaForward(
  fetch: OwaFetcher,
  id: string,
  opts: { to?: string[]; body?: string; html?: boolean }
): Promise<OwaDraftResult> {
  const draft = await fetch("POST", `/messages/${encodeURIComponent(id)}/createForward`);
  const draftId: string = draft?.Id || "";
  if (draftId) {
    const patch: any = {};
    if (opts.to?.length) patch.ToRecipients = toRecipientList(opts.to);
    if (opts.body) {
      const existing: string = draft?.Body?.Content || "";
      const html = opts.html !== false;
      patch.Body = bodyBlock(
        html ? `${opts.body}<br><br>${existing}` : `${opts.body}\n\n${existing}`,
        html
      );
    }
    if (Object.keys(patch).length > 0) {
      await fetch("PATCH", `/messages/${encodeURIComponent(draftId)}`, patch);
    }
  }
  return { id: draftId, threadId: draft?.ConversationId };
}

/** Send an existing draft (POST /messages/{id}/send → 204). */
export async function owaSendDraft(fetch: OwaFetcher, draftId: string): Promise<void> {
  await fetch("POST", `/messages/${encodeURIComponent(draftId)}/send`);
}

/** Compose + send in one call (POST /sendmail, SaveToSentItems). */
export async function owaSendNew(
  fetch: OwaFetcher,
  input: OwaCreateDraftInput
): Promise<void> {
  const message: any = {
    Subject: input.subject || "",
    Body: bodyBlock(input.body || "", input.html !== false),
    ToRecipients: toRecipientList(input.to),
  };
  if (input.cc?.length) message.CcRecipients = toRecipientList(input.cc);
  if (input.bcc?.length) message.BccRecipients = toRecipientList(input.bcc);
  await fetch("POST", "/sendmail", { Message: message, SaveToSentItems: true });
}

// ---------------------------------------------------------------------------
// Mutation verbs (archive / delete / read / flag / label)
// ---------------------------------------------------------------------------

/** Move a message to a well-known destination folder. */
async function owaMove(fetch: OwaFetcher, id: string, dest: string): Promise<void> {
  await fetch("POST", `/messages/${encodeURIComponent(id)}/move`, {
    DestinationId: dest,
  });
}

/** Archive messages (move to the Archive folder). Never a hard delete. */
export async function owaArchive(fetch: OwaFetcher, ids: string[]): Promise<void> {
  for (const id of ids) await owaMove(fetch, id, "archive");
}

/** Delete messages by moving them to Deleted Items (NOT a hard delete). */
export async function owaDelete(fetch: OwaFetcher, ids: string[]): Promise<void> {
  for (const id of ids) await owaMove(fetch, id, "deleteditems");
}

/** Mark a message read/unread (PATCH IsRead). */
export async function owaMarkRead(
  fetch: OwaFetcher,
  id: string,
  read: boolean
): Promise<void> {
  await fetch("PATCH", `/messages/${encodeURIComponent(id)}`, { IsRead: read });
}

/** Flag/unflag a message (star ≈ flag). */
export async function owaFlag(
  fetch: OwaFetcher,
  id: string,
  on: boolean
): Promise<void> {
  await fetch("PATCH", `/messages/${encodeURIComponent(id)}`, {
    Flag: { FlagStatus: on ? "Flagged" : "NotFlagged" },
  });
}

/** List flagged (starred) messages. */
export async function owaListStarred(
  fetch: OwaFetcher,
  meEmail: string,
  opts: { limit?: number } = {}
): Promise<StarredThread[]> {
  const top = opts.limit ?? 50;
  // Exchange rejects $filter combined with $orderby (InefficientFilter); sort
  // newest-first client-side instead.
  const path = `/messages?$top=${top}&$select=${encodeURIComponent(
    MSG_SELECT
  )}&$filter=${encodeURIComponent("Flag/FlagStatus eq 'Flagged'")}`;
  const data = await fetch("GET", path);
  const rows = (data?.value || []).map((m: any): StarredThread => {
    const t = messageToInboxThread(m, meEmail);
    return {
      id: t.id,
      subject: t.subject,
      from: t.from,
      date: t.date,
      snippet: t.snippet,
      labelIds: t.labelIds,
    };
  });
  rows.sort(
    (a: StarredThread, b: StarredThread) =>
      new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
  );
  return rows;
}

/**
 * List labels. Outlook has no Gmail-style labels; the closest analogues are
 * mail folders (Categories are per-message tags). `/me/outlook/masterCategories`
 * 404s on Outlook REST v2.0, so we surface the folder set as labels.
 */
export async function owaListLabels(fetch: OwaFetcher): Promise<Label[]> {
  const data = await fetch(
    "GET",
    "/mailfolders?$top=100&$select=Id,DisplayName"
  );
  return (data?.value || []).map((f: any): Label => ({
    id: f.Id || "",
    name: f.DisplayName || f.Id || "",
    type: "folder",
  }));
}

/** Read a message's current Categories. */
async function owaGetCategories(fetch: OwaFetcher, id: string): Promise<string[]> {
  const m = await fetch(
    "GET",
    `/messages/${encodeURIComponent(id)}?$select=Categories`
  );
  return Array.isArray(m?.Categories) ? m.Categories : [];
}

/** Add a Category to a message (labels ≈ categories on Outlook). */
export async function owaAddLabel(
  fetch: OwaFetcher,
  id: string,
  name: string
): Promise<void> {
  const cats = await owaGetCategories(fetch, id);
  if (cats.includes(name)) return;
  await fetch("PATCH", `/messages/${encodeURIComponent(id)}`, {
    Categories: [...cats, name],
  });
}

/** Remove a Category from a message. */
export async function owaRemoveLabel(
  fetch: OwaFetcher,
  id: string,
  name: string
): Promise<void> {
  const cats = await owaGetCategories(fetch, id);
  if (!cats.includes(name)) return;
  await fetch("PATCH", `/messages/${encodeURIComponent(id)}`, {
    Categories: cats.filter((c) => c !== name),
  });
}

// ---------------------------------------------------------------------------
// Drafts listing (for `draft list`)
// ---------------------------------------------------------------------------

/** List draft messages, mapped to the unified Draft shape. */
export async function owaListDrafts(
  fetch: OwaFetcher,
  limit = 50
): Promise<Draft[]> {
  const select = `${MSG_SELECT},Body`;
  const path = `/mailfolders/drafts/messages?$top=${limit}&$select=${encodeURIComponent(
    select
  )}&$orderby=${encodeURIComponent("LastModifiedDateTime desc")}`;
  const data = await fetch("GET", path);
  return (data?.value || []).map((m: any): Draft => {
    const from = addr(m.From);
    return {
      id: m.Id || "",
      subject: m.Subject || "",
      from: from.name ? `${from.name} <${from.email}>` : from.email,
      to: addrs(m.ToRecipients).map((r) => r.email),
      cc: addrs(m.CcRecipients).map((r) => r.email),
      bcc: [],
      preview: m.BodyPreview || "",
      timestamp: m.ReceivedDateTime || "",
      source: "native",
      threadId: m.ConversationId,
    };
  });
}

// ---------------------------------------------------------------------------
// Calendar verbs
// ---------------------------------------------------------------------------

/** Normalize an Outlook REST calendar event into the CalendarEvent contract. */
function eventToCalendarEvent(e: any): CalendarEvent {
  return {
    id: e.Id || "",
    summary: e.Subject || "",
    description: e.Body?.Content || e.BodyPreview || "",
    start: e.Start?.DateTime || "",
    end: e.End?.DateTime || "",
    location: e.Location?.DisplayName || "",
    attendees: (e.Attendees || [])
      .map((a: any) => a.EmailAddress?.Address || a.EmailAddress?.Name || "")
      .filter(Boolean),
    organizer:
      e.Organizer?.EmailAddress?.Address || e.Organizer?.EmailAddress?.Name || "",
    isAllDay: !!e.IsAllDay,
    status: e.ShowAs || "",
    calendarId: e.calendarId || "",
  };
}

export interface OwaListEventsOptions {
  timeMin?: string;
  timeMax?: string;
  limit?: number;
}

/** List calendar events in a window (calendarview). */
export async function owaListEvents(
  fetch: OwaFetcher,
  opts: OwaListEventsOptions = {}
): Promise<CalendarEvent[]> {
  const start = opts.timeMin || new Date().toISOString();
  const end = opts.timeMax || new Date(Date.now() + 7 * 86400000).toISOString();
  const top = opts.limit ?? 50;
  const path =
    `/calendarview?startDateTime=${encodeURIComponent(start)}` +
    `&endDateTime=${encodeURIComponent(end)}&$top=${top}` +
    `&$orderby=${encodeURIComponent("Start/DateTime")}`;
  const data = await fetch("GET", path);
  return (data?.value || []).map(eventToCalendarEvent);
}

export interface OwaEventInput {
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  timeZone?: string;
}

/** Build the Outlook event body for create/update. */
function eventBody(input: OwaEventInput): any {
  const tz = input.timeZone || "America/New_York";
  const data: any = {};
  if (input.summary !== undefined) data.Subject = input.summary;
  if (input.start !== undefined) data.Start = { DateTime: input.start, TimeZone: tz };
  if (input.end !== undefined) data.End = { DateTime: input.end, TimeZone: tz };
  if (input.description !== undefined)
    data.Body = { ContentType: "Text", Content: input.description };
  if (input.location !== undefined) data.Location = { DisplayName: input.location };
  if (input.attendees?.length) {
    data.Attendees = input.attendees.map((e) => ({
      EmailAddress: { Address: e },
      Type: "Required",
    }));
  }
  return data;
}

/** Create a calendar event (POST /events). Returns the new event id. */
export async function owaCreateEvent(
  fetch: OwaFetcher,
  input: OwaEventInput
): Promise<string> {
  const created = await fetch("POST", "/events", eventBody(input));
  return created?.Id || "";
}

/** Update a calendar event (PATCH /events/{id}). */
export async function owaUpdateEvent(
  fetch: OwaFetcher,
  eventId: string,
  input: OwaEventInput
): Promise<void> {
  await fetch("PATCH", `/events/${encodeURIComponent(eventId)}`, eventBody(input));
}

/** Delete a calendar event (DELETE /events/{id}). */
export async function owaDeleteEvent(
  fetch: OwaFetcher,
  eventId: string
): Promise<void> {
  await fetch("DELETE", `/events/${encodeURIComponent(eventId)}`);
}

/**
 * Free/busy over a window. Outlook REST v2.0 lacks a clean getSchedule for the
 * OWA first-party token, so we derive busy slots from the user's own events in
 * the range (their calendarview) — sufficient for the CLI's availability use.
 */
export async function owaFreeBusy(
  fetch: OwaFetcher,
  timeMin: string,
  timeMax: string
): Promise<{ busy: { start: string; end: string }[]; free: { start: string; end: string }[] }> {
  const events = await owaListEvents(fetch, { timeMin, timeMax, limit: 200 });
  const busy = events
    .filter((e) => e.status !== "Free" && !e.isAllDay)
    .map((e) => ({ start: e.start, end: e.end }))
    .filter((s) => s.start && s.end);
  return { busy, free: [] };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** List non-inline attachments on a message. */
export async function owaListAttachments(
  fetch: OwaFetcher,
  msgId: string
): Promise<Attachment[]> {
  const path = `/messages/${encodeURIComponent(
    msgId
  )}/attachments?$select=Id,Name,ContentType,Size,IsInline`;
  const data = await fetch("GET", path);
  return (data?.value || [])
    .filter((a: any) => !a.IsInline)
    .map((a: any): Attachment => ({
      id: a.Id || "",
      attachmentId: a.Id || "",
      name: a.Name || "attachment",
      mimeType: a.ContentType || "application/octet-stream",
      extension: extOf(a.Name || ""),
      messageId: msgId,
      threadId: msgId,
      inline: false,
    }));
}

/**
 * Upper bound on a single outbound attachment. Outlook REST v2.0 has no
 * `createUploadSession` (verified live: 400 ErrorInvalidReferenceItem), so the
 * inline POST below is the only route and oversized files must be rejected up
 * front rather than failing mid-transfer.
 */
export const OWA_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Attach a file to a draft: POST /messages/{id}/attachments with an inline
 * base64 FileAttachment. `.eml` files go up with ContentType message/rfc822,
 * which Outlook and Gmail both render as an attached message.
 */
export async function owaAddAttachment(
  fetch: OwaFetcher,
  draftId: string,
  att: { name: string; mimeType: string; base64: string }
): Promise<void> {
  const bytes = Math.ceil((att.base64.length * 3) / 4);
  if (bytes > OWA_MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `${att.name} is ${(bytes / 1024 / 1024).toFixed(1)}MB — the Outlook Web backend can only ` +
        `attach files up to ${OWA_MAX_ATTACHMENT_BYTES / 1024 / 1024}MB (no upload-session support).`
    );
  }
  await fetch("POST", `/messages/${encodeURIComponent(draftId)}/attachments`, {
    "@odata.type": "#Microsoft.OutlookServices.FileAttachment",
    Name: att.name,
    ContentType: att.mimeType,
    ContentBytes: att.base64,
  });
}

/** Download an attachment's bytes (base64). */
export async function owaDownloadAttachment(
  fetch: OwaFetcher,
  msgId: string,
  attachmentId: string
): Promise<{ data: string; size: number }> {
  const att = await fetch(
    "GET",
    `/messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  const base64: string = att?.ContentBytes || "";
  return { data: base64, size: att?.Size || Math.ceil((base64.length * 3) / 4) };
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * Search the user's Outlook contacts. Outlook REST v2.0 has no reliable
 * `$search` on /contacts, so we page the contact set and substring-match
 * client-side on name/email, returning the Contact shape.
 */
export async function owaContacts(
  fetch: OwaFetcher,
  query: string,
  limit = 20
): Promise<Contact[]> {
  const data = await fetch(
    "GET",
    "/contacts?$top=200&$select=DisplayName,EmailAddresses"
  );
  const q = query.toLowerCase();
  const out: Contact[] = [];
  for (const c of data?.value || []) {
    const name: string = c.DisplayName || "";
    const emails: any[] = Array.isArray(c.EmailAddresses) ? c.EmailAddresses : [];
    for (const e of emails) {
      const email: string = e.Address || "";
      if (!email) continue;
      if (q && !name.toLowerCase().includes(q) && !email.toLowerCase().includes(q)) {
        continue;
      }
      out.push({ email, name: name || undefined });
    }
  }
  return out.slice(0, limit);
}
