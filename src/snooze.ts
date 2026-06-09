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
