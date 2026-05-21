/**
 * Snooze Module
 *
 * Functions for snoozing and unsnoozing email threads via Superhuman's backend API.
 * Supports both Microsoft/Outlook and Gmail accounts.
 *
 * Uses direct API calls via superhumanFetch (no CDP/browser connection needed).
 * Thread message IDs are resolved from local SQLite first, then portal RPC
 * (`threadInternal.listAsync`) as a fallback.
 */

import type { SuperhumanTokenInfo } from "./token-api";
import { superhumanFetch } from "./token-api";
import type { ConnectionProvider } from "./connection-provider";
import { SuperhumanProvider } from "./superhuman-provider";
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
    });

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
    });

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
    });

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
// ConnectionProvider-based Functions
// These accept a ConnectionProvider and use the direct API functions internally.
// ============================================================================

/**
 * Resolve a thread's canonical thread ID and the list of message IDs it
 * contains. Tries local SQLite first (works without a CDP connection), and
 * falls back to portal RPC `threadInternal.listAsync` (same path as
 * `superhuman read`). Errors from both paths are surfaced rather than
 * swallowed so callers can see auth/network/shape failures.
 *
 * Note: `threadInternal.getAsync` does NOT exist on the Superhuman portal;
 * the previous implementation that called it always failed silently. See
 * `src/read.ts` (`readThreadPortal`) for the working pattern this mirrors.
 */
async function resolveThreadForSnooze(
  provider: ConnectionProvider,
  threadId: string
): Promise<{ canonicalThreadId: string; messageIds: string[] }> {
  if (!(provider instanceof SuperhumanProvider)) {
    throw new Error(
      "SuperhumanProvider required to resolve thread message IDs. " +
      "Run 'superhuman account auth' to authenticate."
    );
  }

  // 1. Try local SQLite (OPFS blob) — no CDP needed, matches read.ts path.
  // `readThreadFromDB` looks up by exact thread_id first, then falls back
  // to searching for a message ID inside the thread JSON, and tags the
  // result with `_canonicalThreadId` so we can use the right ID for the
  // reminders API.
  const accountEmail = await provider.getCurrentEmail();
  if (accountEmail) {
    try {
      const json = readThreadFromDB(accountEmail, threadId);
      if (json) {
        const rawMessages = Array.isArray((json as any).messages)
          ? ((json as any).messages as any[])
          : typeof (json as any).messages === "object" && (json as any).messages !== null
          ? (Object.values((json as any).messages) as any[])
          : [];
        const messageIds = rawMessages
          .map((m: any) => m?.id || m?.message_id)
          .filter(Boolean);
        if (messageIds.length > 0) {
          const canonicalThreadId =
            (json as any)._canonicalThreadId ||
            (json as any).id ||
            threadId;
          return { canonicalThreadId, messageIds };
        }
      }
    } catch (e) {
      // SQLite read failed — fall through to portal RPC. Don't hide it
      // entirely; the portal fallback may still succeed and the user will
      // get a real error if it doesn't.
      console.error(
        `[snooze] SQLite lookup for ${threadId} failed: ${(e as Error).message}`
      );
    }
  }

  // 2. Fall back to portal `threadInternal.listAsync` (same as read.ts).
  if (!provider.hasPortal()) {
    throw new Error(
      `Thread ${threadId} not found in local SQLite cache, and no CDP ` +
      `connection is available to query the Superhuman portal. ` +
      `Open Superhuman in Chrome (with --remote-debugging-port=9400) or ` +
      `sync the thread by visiting it in the app, then retry.`
    );
  }

  const BATCH_SIZE = 200;
  const result = await provider.portalInvoke("threadInternal", "listAsync", [
    "INBOX",
    { limit: BATCH_SIZE, query: "" },
  ]);

  const rawThreads: any[] = Array.isArray(result)
    ? result
    : Array.isArray(result?.threads)
    ? result.threads
    : [];

  for (const item of rawThreads) {
    const json = item?.json;
    if (!json) continue;

    const messages: any[] = Array.isArray(json.messages)
      ? json.messages
      : typeof json.messages === "object" && json.messages !== null
      ? Object.values(json.messages)
      : [];

    const threadInternalId: string = json.id || "";
    const isMatch =
      threadInternalId === threadId ||
      messages.some((m: any) => m?.id === threadId);

    if (!isMatch) continue;

    const messageIds = messages
      .map((m: any) => m?.id || m?.message_id)
      .filter(Boolean);

    if (messageIds.length === 0) {
      throw new Error(
        `Portal returned thread ${threadInternalId} for ${threadId} ` +
        `but its messages list was empty.`
      );
    }

    return {
      canonicalThreadId: threadInternalId || threadId,
      messageIds,
    };
  }

  throw new Error(
    `Thread ${threadId} not found via portal listAsync (searched ` +
    `${rawThreads.length} INBOX threads) or local SQLite. The portal RPC ` +
    `currently only enumerates INBOX; archived/snoozed threads cannot be ` +
    `resolved this way.`
  );
}

/**
 * Snooze a thread using ConnectionProvider.
 * Gets token from the provider, resolves message IDs via MCP, then calls the direct API.
 */
export async function snoozeThreadViaProvider(
  provider: ConnectionProvider,
  threadIds: string[],
  snoozeUntil: Date | string
): Promise<SnoozeResult[]> {
  const token = await provider.getToken();

  if (!token.idToken) {
    throw new Error(
      "Superhuman backend credentials required for snooze. Run 'superhuman account auth'."
    );
  }

  const superhumanToken: SuperhumanTokenInfo = {
    token: token.idToken,
    email: token.email,
  };

  const triggerAt = typeof snoozeUntil === "string" ? snoozeUntil : snoozeUntil.toISOString();
  const results: SnoozeResult[] = [];

  for (const threadId of threadIds) {
    let canonicalThreadId: string;
    let messageIds: string[];
    try {
      ({ canonicalThreadId, messageIds } = await resolveThreadForSnooze(
        provider,
        threadId
      ));
    } catch (e) {
      results.push({ success: false, error: (e as Error).message });
      continue;
    }

    const result = await snoozeThreadDirect(
      superhumanToken,
      canonicalThreadId,
      messageIds,
      triggerAt
    );
    results.push(result);
  }

  return results;
}

/**
 * Unsnooze threads using ConnectionProvider.
 * First lists snoozed threads to find reminder IDs, then cancels them.
 */
export async function unsnoozeThreadViaProvider(
  provider: ConnectionProvider,
  threadIds: string[]
): Promise<SnoozeResult[]> {
  const token = await provider.getToken();

  if (!token.idToken) {
    throw new Error(
      "Superhuman backend credentials required for unsnooze. Run 'superhuman account auth'."
    );
  }

  const superhumanToken: SuperhumanTokenInfo = {
    token: token.idToken,
    email: token.email,
  };

  // Fetch all snoozed threads to find reminder IDs
  const snoozedThreads = await listSnoozedDirect(superhumanToken, 200);
  const results: SnoozeResult[] = [];

  for (const threadId of threadIds) {
    const snoozed = snoozedThreads.find((t) => t.id === threadId);
    if (!snoozed?.reminderId) {
      results.push({
        success: false,
        error: "Could not find reminder ID for thread",
      });
      continue;
    }

    const result = await unsnoozeThreadDirect(
      superhumanToken,
      threadId,
      snoozed.reminderId
    );
    results.push(result);
  }

  return results;
}

/**
 * List snoozed threads using ConnectionProvider.
 */
export async function listSnoozedViaProvider(
  provider: ConnectionProvider,
  limit: number = 50
): Promise<SnoozedThread[]> {
  const token = await provider.getToken();

  if (!token.idToken) {
    throw new Error(
      "Superhuman backend credentials required for listing snoozed threads. Run 'superhuman account auth'."
    );
  }

  const superhumanToken: SuperhumanTokenInfo = {
    token: token.idToken,
    email: token.email,
  };

  return listSnoozedDirect(superhumanToken, limit);
}
