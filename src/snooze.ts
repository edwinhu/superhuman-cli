/**
 * Snooze Module
 *
 * Functions for snoozing and unsnoozing email threads via Superhuman's backend API.
 * Supports both Microsoft/Outlook and Gmail accounts.
 *
 * Uses direct API calls via superhumanFetch (no CDP/browser connection needed).
 * Thread message IDs are resolved via MCP get_email_thread.
 */

import type { SuperhumanTokenInfo } from "./token-api";
import { superhumanFetch } from "./token-api";
import type { ConnectionProvider } from "./connection-provider";
import { McpConnectionProvider, getMcpText } from "./mcp-provider";

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
 * Get message IDs for a thread using MCP get_email_thread.
 */
async function getThreadMessageIds(
  provider: ConnectionProvider,
  threadId: string
): Promise<string[]> {
  if (!(provider instanceof McpConnectionProvider)) {
    throw new Error(
      "MCP provider required to resolve thread message IDs. " +
      "Provider-specific OAuth has been removed. " +
      "Use 'superhuman account auth --mcp' to set up MCP authentication."
    );
  }

  try {
    const result = await provider.callTool("get_email_thread", {
      thread_id: threadId,
    });
    const text = getMcpText(result);
    const json = JSON.parse(text);

    // MCP get_email_thread returns messages array with id fields
    const messages = Array.isArray(json) ? json : (json.messages || []);
    return messages.map((m: any) => m.id || m.message_id).filter(Boolean);
  } catch {
    return [];
  }
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
    // Get message IDs for the thread via MCP
    const messageIds = await getThreadMessageIds(provider, threadId);
    if (messageIds.length === 0) {
      results.push({ success: false, error: "No messages found in thread" });
      continue;
    }

    const result = await snoozeThreadDirect(superhumanToken, threadId, messageIds, triggerAt);
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
