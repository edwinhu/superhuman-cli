/**
 * Superhuman Internal API Wrapper
 *
 * Provides programmatic access to Superhuman's internal APIs via Chrome DevTools Protocol (CDP).
 */

import CDP from "chrome-remote-interface";

export interface SuperhumanConnection {
  client: CDP.Client;
  Runtime: CDP.Client["Runtime"];
  Input: CDP.Client["Input"];
  Network: CDP.Client["Network"];
  Page: CDP.Client["Page"];
}

export interface DraftState {
  id: string;
  subject: string;
  body: string;
  to: string[];
  cc: string[];
  bcc: string[];
  from: string;
  isDirty: boolean;
}

/**
 * Check if Superhuman is running with CDP enabled
 */
export async function isSuperhmanRunning(port = 9333): Promise<boolean> {
  try {
    const targets = await CDP.List({ port });
    return targets.some(t => t.url.includes("mail.superhuman.com"));
  } catch {
    return false;
  }
}

/**
 * Launch Superhuman with remote debugging enabled
 */
export async function launchSuperhuman(port = 9333): Promise<boolean> {
  const appPath = "/Applications/Superhuman.app/Contents/MacOS/Superhuman";

  // Check if already running
  if (await isSuperhmanRunning(port)) {
    return true;
  }

  // Launch in background with CDP enabled
  console.log("Launching Superhuman with remote debugging...");
  try {
    // Use Bun's shell to launch in background
    Bun.spawn([appPath, `--remote-debugging-port=${port}`], {
      stdout: "ignore",
      stderr: "ignore",
    });

    // Wait for Superhuman to be ready (up to 30 seconds)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await isSuperhmanRunning(port)) {
        console.log("Superhuman is ready");
        // Give it a bit more time to fully initialize
        await new Promise(r => setTimeout(r, 2000));
        return true;
      }
    }
    console.error("Timeout waiting for Superhuman to start");
    return false;
  } catch (e) {
    console.error("Failed to launch Superhuman:", (e as Error).message);
    return false;
  }
}

/**
 * Ensure Superhuman is running, launching it if necessary
 */
export async function ensureSuperhuman(port = 9333): Promise<boolean> {
  if (await isSuperhmanRunning(port)) {
    return true;
  }
  return launchSuperhuman(port);
}

/**
 * Find and connect to the Superhuman main page via CDP
 */
export async function connectToSuperhuman(
  port = 9333,
  autoLaunch = true
): Promise<SuperhumanConnection | null> {
  // Auto-launch if not running
  if (autoLaunch && !(await isSuperhmanRunning(port))) {
    const launched = await launchSuperhuman(port);
    if (!launched) {
      return null;
    }
  }

  const targets = await CDP.List({ port });

  const mainPage = targets.find(
    (t) =>
      t.url.includes("mail.superhuman.com") &&
      !t.url.includes("background") &&
      !t.url.includes("serviceworker") &&
      t.type === "page"
  );

  if (!mainPage) {
    console.error("Could not find Superhuman main page");
    return null;
  }

  const client = await CDP({ target: mainPage.id, port });

  // Enable Page domain for navigation events
  await client.Page.enable();

  return {
    client,
    Runtime: client.Runtime,
    Input: client.Input,
    Network: client.Network,
    Page: client.Page,
  };
}

/**
 * Open the full compose form by clicking ThreadListView-compose
 */
export async function openCompose(conn: SuperhumanConnection): Promise<string | null> {
  const { Runtime } = conn;

  await closeExistingCompose(conn);

  await Runtime.evaluate({
    expression: `document.querySelector('.ThreadListView-compose')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 2000));

  return getDraftKey(conn);
}

/**
 * Get current draft state
 */
export async function getDraftState(
  conn: SuperhumanConnection
): Promise<DraftState | null> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const cfc = window.ViewState?._composeFormController;
          if (!cfc) return null;
          const draftKey = Object.keys(cfc).find(k => k.startsWith('draft'));
          if (!draftKey) return null;
          const ctrl = cfc[draftKey];
          const draft = ctrl?.state?.draft;
          if (!draft) return null;
          return {
            id: draft.id,
            subject: draft.subject || draft.getSubject?.() || '',
            body: draft.body || draft.getBody?.() || '',
            to: (draft.to || draft.getTo?.() || []).map(r => r.email),
            cc: (draft.cc || draft.getCc?.() || []).map(r => r.email),
            bcc: (draft.bcc || draft.getBcc?.() || []).map(r => r.email),
            from: draft.from?.email || '',
            isDirty: draft.dirty || false,
          };
        } catch (e) {
          return null;
        }
      })()
    `,
    returnByValue: true,
  });

  return result.result.value as DraftState | null;
}

/**
 * Helper to execute code on the draft controller
 */
async function withDraftController<T>(
  conn: SuperhumanConnection,
  code: string,
  draftId?: string
): Promise<T | null> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const cfc = window.ViewState?._composeFormController;
          if (!cfc) return null;
          
          const draftId = ${JSON.stringify(draftId || null)};
          let draftKey = draftId;
          
          if (!draftKey) {
            draftKey = Object.keys(cfc).find(k => k.startsWith('draft'));
          }
          
          if (!draftKey) return null;
          const ctrl = cfc[draftKey];
          if (!ctrl) return null;
          ${code}
        } catch (e) {
          return null;
        }
      })()
    `,
    returnByValue: true,
  });

  return result.result.value as T | null;
}

/**
 * Set the subject of the current draft
 */
export async function setSubject(
  conn: SuperhumanConnection,
  subject: string,
  draftId?: string
): Promise<boolean> {
  const result = await withDraftController<boolean>(
    conn,
    `
      if (typeof ctrl.setSubject !== 'function') return false;
      ctrl.setSubject(${JSON.stringify(subject)});
      return true;
    `,
    draftId
  );
  return result === true;
}

/**
 * Add a recipient to the To field
 */
export async function addRecipient(
  conn: SuperhumanConnection,
  email: string,
  name?: string,
  draftId?: string
): Promise<boolean> {
  const result = await withDraftController<boolean>(
    conn,
    `
      const draft = ctrl?.state?.draft;
      if (!draft?.from?.constructor) return false;

      const existingTo = draft.to || [];

      // Check if email already exists in To field
      const alreadyExists = existingTo.some(r => r.email === ${JSON.stringify(email)});
      if (alreadyExists) return true; // Already there, success

      const Recipient = draft.from.constructor;
      const newRecipient = new Recipient({
        email: ${JSON.stringify(email)},
        name: ${JSON.stringify(name || "")},
        raw: ${JSON.stringify(name ? `${name} <${email}>` : email)},
      });

      ctrl._updateDraft({ to: [...existingTo, newRecipient] });
      return true;
    `,
    draftId
  );
  return result === true;
}

/**
 * Add a recipient to the Cc field
 */
export async function addCcRecipient(
  conn: SuperhumanConnection,
  email: string,
  name?: string,
  draftId?: string
): Promise<boolean> {
  const result = await withDraftController<boolean>(
    conn,
    `
      const draft = ctrl?.state?.draft;
      if (!draft?.from?.constructor) return false;

      const existingCc = draft.cc || [];

      // Check if email already exists in Cc field
      const alreadyExists = existingCc.some(r => r.email === ${JSON.stringify(email)});
      if (alreadyExists) return true; // Already there, success

      const Recipient = draft.from.constructor;
      const newRecipient = new Recipient({
        email: ${JSON.stringify(email)},
        name: ${JSON.stringify(name || "")},
        raw: ${JSON.stringify(name ? `${name} <${email}>` : email)},
      });

      ctrl._updateDraft({ cc: [...existingCc, newRecipient] });
      return true;
    `,
    draftId
  );
  return result === true;
}

/**
 * Set the body of the current draft
 */
export async function setBody(
  conn: SuperhumanConnection,
  html: string,
  draftId?: string
): Promise<boolean> {
  const result = await withDraftController<boolean>(
    conn,
    `
      if (typeof ctrl._updateDraft !== 'function') return false;
      ctrl._updateDraft({ body: ${JSON.stringify(html)} });
      return true;
    `,
    draftId
  );
  return result === true;
}

/**
 * Save the current draft
 */
export async function saveDraft(conn: SuperhumanConnection, draftId?: string): Promise<boolean> {
  const result = await withDraftController<boolean>(
    conn,
    `
      if (typeof ctrl._saveDraftAsync !== 'function') return false;
      ctrl._saveDraftAsync();
      return true;
    `,
    draftId
  );

  await new Promise((r) => setTimeout(r, 2000));
  return result === true;
}

/**
 * Close the compose form
 */
export async function closeCompose(conn: SuperhumanConnection): Promise<void> {
  await closeExistingCompose(conn);
}

/**
 * Disconnect from Superhuman
 */
export async function disconnect(conn: SuperhumanConnection): Promise<void> {
  await conn.client.close();
}

/**
 * Send the current draft
 */
export async function sendDraft(conn: SuperhumanConnection, draftId?: string): Promise<boolean> {
  const result = await withDraftController<boolean>(
    conn,
    `
      if (typeof ctrl._sendDraft !== 'function') return false;
      ctrl._sendDraft();
      return true;
    `,
    draftId
  );
  return result === true;
}

/**
 * Convert plain text to HTML paragraphs (returns as-is if already HTML)
 */
export function textToHtml(text: string): string {
  if (text.includes("<")) return text;
  return `<p>${text.replace(/\n/g, "</p><p>")}</p>`;
}

/**
 * Get the draft key from the compose form controller
 */
async function getDraftKey(conn: SuperhumanConnection): Promise<string | null> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const cfc = window.ViewState?._composeFormController;
          if (!cfc) return null;
          const keys = Object.keys(cfc);
          return keys.find(k => k.startsWith('draft')) || null;
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
 * Invoke a Superhuman regional command by ID
 */
async function invokeCommand(
  conn: SuperhumanConnection,
  commandId: string
): Promise<boolean> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const rc = window.ViewState?.regionalCommands;
          for (const region of rc) {
            if (region?.commands) {
              for (const cmd of region.commands) {
                if (cmd.id === ${JSON.stringify(commandId)} && typeof cmd.action === 'function') {
                  const mockEvent = {
                    preventDefault: () => {},
                    stopPropagation: () => {},
                  };
                  cmd.action(mockEvent);
                  return true;
                }
              }
            }
          }
          return false;
        } catch (e) {
          return false;
        }
      })()
    `,
    returnByValue: true,
  });

  return result.result.value === true;
}

/**
 * Close any existing compose window and prepare for a new one
 */
async function closeExistingCompose(conn: SuperhumanConnection): Promise<void> {
  const { Input } = conn;

  await Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape" });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
  await new Promise((r) => setTimeout(r, 500));
}

/**
 * Open a compose window using a Superhuman command
 */
async function openComposeWithCommand(
  conn: SuperhumanConnection,
  commandId: string,
  threadId?: string
): Promise<string | null> {
  await closeExistingCompose(conn);

  // If a specific threadId is provided, set it before invoking the command
  if (threadId) {
    await setThreadForReply(conn, threadId);
    await new Promise((r) => setTimeout(r, 300)); // Give UI time to update
  } else {
    await syncThreadId(conn);
  }

  const invoked = await invokeCommand(conn, commandId);
  if (!invoked) {
    return null;
  }

  await new Promise((r) => setTimeout(r, 2000));
  return getDraftKey(conn);
}

/**
 * Set a specific thread ID in the ViewState for reply operations
 *
 * This sets both threadPane.threadId and threadListView.threadId to ensure
 * the reply commands work correctly regardless of what's currently visible.
 */
export async function setThreadForReply(conn: SuperhumanConnection, threadId: string): Promise<boolean> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const tree = window.ViewState?.tree;
          if (!tree?.set) return false;

          const targetThreadId = ${JSON.stringify(threadId)};

          // Set both threadPane and threadListView to the target thread
          tree.set(['threadPane', 'threadId'], targetThreadId);
          tree.set(['threadListView', 'threadId'], targetThreadId);

          return true;
        } catch (e) {
          return false;
        }
      })()
    `,
    returnByValue: true,
  });

  return result.result.value === true;
}

/**
 * Sync threadListView.threadId with threadPane.threadId
 *
 * This fixes a bug where reply commands use threadListView.threadId
 * (the last selected thread in the list) instead of threadPane.threadId
 * (the currently open thread).
 */
export async function syncThreadId(conn: SuperhumanConnection): Promise<boolean> {
  const { Runtime } = conn;

  const result = await Runtime.evaluate({
    expression: `
      (() => {
        try {
          const tree = window.ViewState?.tree;
          const data = tree?.get?.() || tree?._data;
          const threadPaneId = data?.threadPane?.threadId;

          if (!threadPaneId || !tree?.set) return false;

          tree.set(['threadListView', 'threadId'], threadPaneId);
          return true;
        } catch (e) {
          return false;
        }
      })()
    `,
    returnByValue: true,
  });

  return result.result.value === true;
}

/**
 * Open a reply-all compose using Superhuman's native command.
 *
 * This uses the REPLY_ALL_POP_OUT command which properly sets up threading,
 * recipients, and subject automatically.
 *
 * @param conn - The Superhuman connection
 * @param threadId - Optional thread ID to reply to (if not provided, uses current thread)
 */
export async function openReplyAllCompose(conn: SuperhumanConnection, threadId?: string): Promise<string | null> {
  return openComposeWithCommand(conn, "REPLY_ALL_POP_OUT", threadId);
}

/**
 * Open a reply compose using Superhuman's native command.
 *
 * This uses the REPLY_POP_OUT command which properly sets up threading,
 * recipient (original sender only), and subject automatically.
 *
 * @param conn - The Superhuman connection
 * @param threadId - Optional thread ID to reply to (if not provided, uses current thread)
 */
export async function openReplyCompose(conn: SuperhumanConnection, threadId?: string): Promise<string | null> {
  return openComposeWithCommand(conn, "REPLY_POP_OUT", threadId);
}

/**
 * Open a forward compose using Superhuman's native command.
 *
 * This uses the FORWARD_POP_OUT command which properly sets up the
 * forwarded message content and subject automatically.
 *
 * @param conn - The Superhuman connection
 * @param threadId - Optional thread ID to forward (if not provided, uses current thread)
 */
export async function openForwardCompose(conn: SuperhumanConnection, threadId?: string): Promise<string | null> {
  return openComposeWithCommand(conn, "FORWARD_POP_OUT", threadId);
}
