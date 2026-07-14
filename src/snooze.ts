/**
 * Snooze Module
 *
 * Functions for snoozing and unsnoozing email threads via Superhuman's backend API.
 * Supports both Microsoft/Outlook and Gmail accounts.
 *
 * Uses direct API calls via superhumanFetch (no CDP/browser connection needed).
 * Thread message IDs are resolved from the local SQLite cache.
 */

import type { SuperhumanTokenInfo, TokenInfo } from "./token-api";
import { superhumanFetch } from "./token-api";
import { readThreadFromDB } from "./sqlite-search";

export interface SnoozeResult {
  success: boolean;
  reminderId?: string;
  error?: string;
}

export interface SnoozedThread {
  id: string;
  snoozeUntil?: string;
  reminderId?: string;
}

/**
 * Preset snooze times
 */
export type SnoozePreset = "tomorrow" | "next-week" | "weekend" | "evening";

/**
 * Calculate snooze time from preset
 */
export function getSnoozeTimeFromPreset(preset: SnoozePreset): Date {
  const now = new Date();
  const result = new Date();

  switch (preset) {
    case "tomorrow":
      // Tomorrow at 9 AM
      result.setDate(now.getDate() + 1);
      result.setHours(9, 0, 0, 0);
      break;
    case "next-week":
      // Next Monday at 9 AM
      const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
      result.setDate(now.getDate() + daysUntilMonday);
      result.setHours(9, 0, 0, 0);
      break;
    case "weekend":
      // Saturday at 9 AM
      const daysUntilSaturday = (6 - now.getDay() + 7) % 7 || 7;
      result.setDate(now.getDate() + daysUntilSaturday);
      result.setHours(9, 0, 0, 0);
      break;
    case "evening":
      // Today at 6 PM, or tomorrow if past 6 PM
      result.setHours(18, 0, 0, 0);
      if (result <= now) {
        result.setDate(result.getDate() + 1);
      }
      break;
  }

  return result;
}

/**
 * Parse snooze time from string (preset or ISO datetime)
 */
export function parseSnoozeTime(timeStr: string): Date {
  // Check if it's a preset
  const presets: SnoozePreset[] = ["tomorrow", "next-week", "weekend", "evening"];
  if (presets.includes(timeStr as SnoozePreset)) {
    return getSnoozeTimeFromPreset(timeStr as SnoozePreset);
  }

  // Try to parse as ISO datetime
  const date = new Date(timeStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid snooze time: ${timeStr}`);
  }

  return date;
}

/**
 * Parse a "send later" / scheduled-send time string into a future Date.
 *
 * Richer than {@link parseSnoozeTime}: accepts the snooze presets, an ISO
 * datetime, AND natural day/time forms so `draft send --at "monday morning"`
 * works the way a user types it. Recognised forms (case-insensitive):
 *
 *   - presets: tomorrow | next-week | weekend | evening
 *   - weekday (optionally "next "): "monday", "next friday", "mon 9am",
 *     "monday morning", "tuesday 14:30"
 *   - time-of-day alone: "morning" (9am), "afternoon" (2pm), "evening" (6pm),
 *     "noon" — today if still ahead, else tomorrow
 *   - bare clock time: "9am", "3:30pm", "14:00" — today if ahead else tomorrow
 *   - anything Date can parse (ISO 8601, "2026-06-15 09:00", …)
 *
 * Throws if the string can't be parsed or resolves to a past time.
 */
export function parseSendAtTime(input: string): Date {
  const raw = input.trim();
  if (!raw) throw new Error("Empty schedule time");
  const lower = raw.toLowerCase();
  const now = new Date();

  // Snooze presets share the same intent (next-week === next Monday 9am).
  const presets: SnoozePreset[] = ["tomorrow", "next-week", "weekend", "evening"];
  if (presets.includes(lower as SnoozePreset)) {
    return getSnoozeTimeFromPreset(lower as SnoozePreset);
  }

  // Named time-of-day → hour mapping.
  const timeOfDay: Record<string, number> = {
    morning: 9,
    noon: 12,
    afternoon: 14,
    evening: 18,
    night: 20,
  };

  // Pull an explicit clock time ("9am", "3:30pm", "14:00") out of the string.
  const parseClock = (s: string): { h: number; m: number } | null => {
    const m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (!m) return null;
    let h = parseInt(m[1]!, 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3];
    if (h > 23 || min > 59) return null;
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return { h, m: min };
  };

  // Resolve hour/minute from any time-of-day word or clock time in the string;
  // default to 9am (a sensible "morning") when only a day is given.
  const resolveTime = (s: string): { h: number; m: number } => {
    for (const [word, hr] of Object.entries(timeOfDay)) {
      if (s.includes(word)) return { h: hr, m: 0 };
    }
    return parseClock(s) ?? { h: 9, m: 0 };
  };

  // Weekday handling: "monday", "next fri", "tuesday 14:30", "mon morning".
  const weekdays = [
    "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
  ];
  const dayMatch = lower.match(
    /\b(next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/
  );
  if (dayMatch) {
    const abbr = dayMatch[2]!;
    const target = weekdays.findIndex((d) => d.startsWith(abbr));
    if (target !== -1) {
      const result = new Date(now);
      const { h, m } = resolveTime(lower);
      let delta = (target - now.getDay() + 7) % 7;
      // Same weekday today: only keep "today" if the time is still ahead and
      // the user didn't say "next". Otherwise jump a week.
      if (delta === 0) {
        const candidate = new Date(now);
        candidate.setHours(h, m, 0, 0);
        if (dayMatch[1] || candidate <= now) delta = 7;
      } else if (dayMatch[1] && delta < 7) {
        // "next <day>": if the day is still ahead this week, push to next week.
        delta += 7;
      }
      result.setDate(now.getDate() + delta);
      result.setHours(h, m, 0, 0);
      return result;
    }
  }

  // "tomorrow 3pm" / "tomorrow morning".
  if (lower.startsWith("tomorrow")) {
    const { h, m } = resolveTime(lower);
    const result = new Date(now);
    result.setDate(now.getDate() + 1);
    result.setHours(h, m, 0, 0);
    return result;
  }
  if (lower.startsWith("today")) {
    const { h, m } = resolveTime(lower);
    const result = new Date(now);
    result.setHours(h, m, 0, 0);
    if (result <= now) {
      throw new Error(`"${raw}" is in the past`);
    }
    return result;
  }

  // Time-of-day word or bare clock alone → today if ahead, else tomorrow.
  const todWord = Object.keys(timeOfDay).find((w) => lower === w);
  const bareClock = parseClock(lower);
  if (todWord || (bareClock && /^[\d:apm\s]+$/.test(lower))) {
    const { h, m } = todWord ? { h: timeOfDay[todWord]!, m: 0 } : bareClock!;
    const result = new Date(now);
    result.setHours(h, m, 0, 0);
    if (result <= now) result.setDate(result.getDate() + 1);
    return result;
  }

  // Fall back to native Date parsing (ISO 8601, "2026-06-15 09:00", …).
  const date = new Date(raw);
  if (isNaN(date.getTime())) {
    throw new Error(`Could not parse schedule time: "${raw}"`);
  }
  if (date <= now) {
    throw new Error(`Schedule time "${raw}" is in the past`);
  }
  return date;
}

// ============================================================================
// Direct API Functions (using Superhuman Backend Token)
// These bypass CDP and call Superhuman's backend APIs directly.
// ============================================================================

/**
 * Generate a UUID for reminder IDs.
 */
function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Snooze a thread using direct Superhuman backend API.
 *
 * @param token - Superhuman backend token
 * @param threadId - Thread ID to snooze
 * @param messageIds - Array of message IDs in the thread
 * @param snoozeUntil - When to unsnooze (ISO string)
 * @returns Result with success status and reminder ID
 */
export async function snoozeThreadDirect(
  token: SuperhumanTokenInfo,
  threadId: string,
  messageIds: string[],
  snoozeUntil: string
): Promise<SnoozeResult> {
  const reminderId = generateUUID();
  const now = new Date().toISOString();

  const reminderData = {
    reminderId,
    threadId,
    messageIds,
    triggerAt: snoozeUntil,
    clientCreatedAt: now,
  };

  try {
    const result = await superhumanFetch(token.token, "/reminders/create", {
      method: "POST",
      body: JSON.stringify({
        reminder: reminderData,
        markDone: false,
        moveToInbox: false,
        poll: true,
      }),
    }, token.email);

    if (result === null) {
      return { success: false, error: "Authentication failed" };
    }

    return { success: true, reminderId };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Unsnooze a thread using direct Superhuman backend API.
 *
 * @param token - Superhuman backend token
 * @param threadId - Thread ID to unsnooze
 * @param reminderId - Reminder ID to cancel
 * @returns Result with success status
 */
export async function unsnoozeThreadDirect(
  token: SuperhumanTokenInfo,
  threadId: string,
  reminderId: string
): Promise<SnoozeResult> {
  try {
    const result = await superhumanFetch(token.token, "/reminders/cancel", {
      method: "POST",
      body: JSON.stringify({
        reminderId,
        threadId,
        moveToInbox: true,
        poll: true,
      }),
    }, token.email);

    if (result === null) {
      return { success: false, error: "Authentication failed" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * List snoozed threads using direct Superhuman backend API.
 *
 * @param token - Superhuman backend token
 * @param limit - Maximum number of threads to return
 * @returns Array of snoozed threads
 */
export async function listSnoozedDirect(
  token: SuperhumanTokenInfo,
  limit: number = 50
): Promise<SnoozedThread[]> {
  try {
    const result = await superhumanFetch(token.token, "/v3/userdata.getThreads", {
      method: "POST",
      body: JSON.stringify({
        filter: { type: "reminder" },
        offset: 0,
        limit,
      }),
    }, token.email);

    if (result === null || !result.threadList) {
      return [];
    }

    return result.threadList.map((item: any) => ({
      id: item.thread?.reminder?.threadId || "",
      snoozeUntil: item.thread?.reminder?.triggerAt,
      reminderId: item.thread?.reminder?.reminderId,
    }));
  } catch (_e) {
    return [];
  }
}

// ============================================================================
// Token-direct command-facing functions
// These accept a resolved TokenInfo and use the direct API functions internally.
// ============================================================================

/**
 * Resolve a thread's canonical thread ID and the list of message IDs it
 * contains from the local SQLite cache (token-direct, no running app needed).
 */
function resolveThreadForSnooze(
  email: string,
  threadId: string
): { canonicalThreadId: string; messageIds: string[] } {
  // Token-direct: resolve the thread's message ids from the local SQLite (OPFS
  // blob) cache. No running app / portal needed.
  const json = readThreadFromDB(email, threadId);
  if (!json) {
    throw new Error(
      `Thread ${threadId} not found in the local cache. Open it in the Superhuman ` +
      `app to sync it, then retry.`
    );
  }
  const rawMessages = Array.isArray((json as any).messages)
    ? ((json as any).messages as any[])
    : typeof (json as any).messages === "object" && (json as any).messages !== null
    ? (Object.values((json as any).messages) as any[])
    : [];
  const messageIds = rawMessages
    .map((m: any) => m?.id || m?.message_id)
    .filter(Boolean);
  if (messageIds.length === 0) {
    throw new Error(
      `Thread ${threadId} has no resolvable message ids in the local cache.`
    );
  }
  const canonicalThreadId =
    (json as any)._canonicalThreadId || (json as any).id || threadId;
  return { canonicalThreadId, messageIds };
}

/** The Superhuman backend bearer (id-token), with email for 401 refresh. */
function superhumanTokenOf(token: TokenInfo): SuperhumanTokenInfo {
  return {
    token: token.superhumanToken?.token || token.idToken || "",
    email: token.email,
  };
}

/**
 * Snooze threads (token-direct). Resolves message ids from local SQLite, then
 * calls the reminders API. No running app required.
 */
export async function snoozeThreads(
  token: TokenInfo,
  threadIds: string[],
  snoozeUntil: Date | string
): Promise<SnoozeResult[]> {
  const superhumanToken = superhumanTokenOf(token);
  if (!superhumanToken.token) {
    throw new Error(
      "Superhuman backend credentials required for snooze. Run 'superhuman account auth'."
    );
  }

  const triggerAt =
    typeof snoozeUntil === "string" ? snoozeUntil : snoozeUntil.toISOString();
  const results: SnoozeResult[] = [];

  for (const threadId of threadIds) {
    let canonicalThreadId: string;
    let messageIds: string[];
    try {
      ({ canonicalThreadId, messageIds } = resolveThreadForSnooze(token.email, threadId));
    } catch (e) {
      results.push({ success: false, error: (e as Error).message });
      continue;
    }
    results.push(
      await snoozeThreadDirect(superhumanToken, canonicalThreadId, messageIds, triggerAt)
    );
  }

  return results;
}

/**
 * Unsnooze threads (token-direct). Lists snoozed reminders to find reminder ids,
 * then cancels them. No running app required.
 */
export async function unsnoozeThreads(
  token: TokenInfo,
  threadIds: string[]
): Promise<SnoozeResult[]> {
  const superhumanToken = superhumanTokenOf(token);
  if (!superhumanToken.token) {
    throw new Error(
      "Superhuman backend credentials required for unsnooze. Run 'superhuman account auth'."
    );
  }

  // The backend rejects reminder list requests with limit > 100 (HTTP 400), so
  // cap at 100 — otherwise unsnooze could never find the reminder id.
  const snoozedThreads = await listSnoozedDirect(superhumanToken, 100);
  const results: SnoozeResult[] = [];

  for (const threadId of threadIds) {
    const snoozed = snoozedThreads.find((t) => t.id === threadId);
    if (!snoozed?.reminderId) {
      results.push({ success: false, error: "Could not find reminder ID for thread" });
      continue;
    }
    results.push(await unsnoozeThreadDirect(superhumanToken, threadId, snoozed.reminderId));
  }

  return results;
}

/** List snoozed threads (token-direct). */
export async function listSnoozed(
  token: TokenInfo,
  limit: number = 50
): Promise<SnoozedThread[]> {
  const superhumanToken = superhumanTokenOf(token);
  if (!superhumanToken.token) {
    throw new Error(
      "Superhuman backend credentials required for listing snoozed threads. Run 'superhuman account auth'."
    );
  }
  return listSnoozedDirect(superhumanToken, limit);
}
