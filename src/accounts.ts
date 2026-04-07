/**
 * Accounts Module
 *
 * Functions for listing and managing linked accounts in Superhuman.
 */

import type { SuperhumanConnection, ChromeExtConnection } from "./superhuman-api";

export interface Account {
  email: string;
  isCurrent: boolean;
}

export interface SwitchResult {
  success: boolean;
  email: string; // current account after switch attempt
}

/**
 * List all linked accounts in Superhuman
 */
/**
 * Get the current account's email address
 */
export async function getCurrentAccount(
  conn: SuperhumanConnection
): Promise<string | null> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          return window.GoogleAccount?.emailAddress || null;
        } catch (e) {
          return null;
        }
      })()
    `,
    returnByValue: true,
  });

  return result.result.value as string | null;
}

/**
 * List all linked accounts in Superhuman
 */
export async function listAccounts(
  conn: SuperhumanConnection
): Promise<Account[]> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          // Get list of all linked accounts
          const accountList = window.GoogleAccount?.accountList?.() || [];

          // Get current account email
          const currentEmail = window.GoogleAccount?.emailAddress || '';

          // Map to Account objects with isCurrent flag
          return accountList.map(email => ({
            email,
            isCurrent: email === currentEmail,
          }));
        } catch (e) {
          return [];
        }
      })()
    `,
    returnByValue: true,
  });

  return (result.result.value as Account[]) || [];
}

/**
 * Switch to a different linked account in Superhuman
 *
 * This function navigates to the account-specific URL which triggers the
 * account switch. It then waits for the page to load and verifies the switch.
 *
 * Note: Account switching fails when Superhuman is showing the calendar view.
 * To work around this, we first navigate to the inbox view of the current
 * account before attempting to switch accounts.
 *
 * @param conn - The Superhuman connection
 * @param targetEmail - The email address of the account to switch to
 * @returns SwitchResult with success status and current email after switch
 */
export async function switchAccount(
  conn: SuperhumanConnection,
  targetEmail: string
): Promise<SwitchResult> {
  const { Runtime, Page } = conn;

  // Enable Page domain before navigating (required for Page.navigate/reload)
  await conn.client.Page.enable();

  // First, navigate to inbox view to ensure we're not in calendar view
  // Account switching fails when in calendar view
  const currentEmail = await getCurrentAccount(conn);
  if (currentEmail) {
    const inboxUrl = `https://mail.superhuman.com/${currentEmail}`;
    await Page.navigate({ url: inboxUrl });

    // Wait for inbox to load before switching accounts
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Navigate to the account-specific URL
  const targetUrl = `https://mail.superhuman.com/${targetEmail}`;
  await Page.navigate({ url: targetUrl });

  // Wait a moment for navigation to start
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Poll to verify the switch completed (up to 10 seconds)
  const maxAttempts = 50;
  const pollIntervalMs = 200;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const checkResult = await Runtime.evaluate({
        expression: `
          (() => {
            try {
              // Check if GoogleAccount is available (page has loaded)
              if (!window.GoogleAccount || !window.GoogleAccount.emailAddress) {
                return { ready: false, email: null };
              }
              return { ready: true, email: window.GoogleAccount.emailAddress };
            } catch (e) {
              return { ready: false, email: null };
            }
          })()
        `,
        returnByValue: true,
      });

      const result = checkResult.result.value as { ready: boolean; email: string | null };

      if (result.ready && result.email === targetEmail) {
        return { success: true, email: result.email };
      }
    } catch {
      // CDP call failed - page might still be loading, continue polling
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout - try to get the current email to report what we ended up with
  try {
    const finalResult = await Runtime.evaluate({
      expression: `window.GoogleAccount?.emailAddress || ''`,
      returnByValue: true,
    });

    const finalEmail = finalResult.result.value as string;
    return { success: finalEmail === targetEmail, email: finalEmail };
  } catch {
    return { success: false, email: "" };
  }
}

// ============================================================================
// Chrome Extension Account Discovery
// ============================================================================

/**
 * Get the current account email from the Chrome extension main page URL.
 * URL format: mail.superhuman.com/{email}/...
 */
export async function getCurrentAccountChrome(
  conn: ChromeExtConnection
): Promise<string | null> {
  const result = await conn.mainClient.Runtime.evaluate({
    expression: `location.pathname.slice(1).split('/')[0]`,
    returnByValue: true,
  });
  const email = result.result.value as string;
  return email?.includes("@") ? email : null;
}

/**
 * List all accounts available in the Chrome extension's service worker.
 * Reads from the `backgrounds` object which maps email -> account background.
 */
export async function listAccountsChrome(
  conn: ChromeExtConnection
): Promise<Account[]> {
  const currentEmail = await getCurrentAccountChrome(conn);

  const result = await conn.swClient.Runtime.evaluate({
    expression: `Object.keys(backgrounds)`,
    returnByValue: true,
  });

  const emails = (result.result.value as string[]) || [];
  return emails.map((email) => ({
    email,
    isCurrent: email === currentEmail,
  }));
}
