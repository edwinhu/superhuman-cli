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
 * Find and connect to the Superhuman main page via CDP
 */
export async function connectToSuperhuman(
  port = 9333
): Promise<SuperhumanConnection | null> {
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
  const { Runtime, Input } = conn;

  // Close any existing compose first
  await Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape" });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
  await new Promise((r) => setTimeout(r, 500));

  // Click the compose area to open full compose
  await Runtime.evaluate({
    expression: `document.querySelector('.ThreadListView-compose')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 2000));

  // Get the draft key
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
  code: string
): Promise<T | null> {
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
  subject: string
): Promise<boolean> {
  const result = await withDraftController<boolean>(
    conn,
    `
      if (typeof ctrl.setSubject !== 'function') return false;
      ctrl.setSubject(${JSON.stringify(subject)});
      return true;
    `
  );
  return result === true;
}

/**
 * Add a recipient to the To field
 */
export async function addRecipient(
  conn: SuperhumanConnection,
  email: string,
  name?: string
): Promise<boolean> {
  const result = await withDraftController<boolean>(
    conn,
    `
      const draft = ctrl?.state?.draft;
      if (!draft?.from?.constructor) return false;

      const Recipient = draft.from.constructor;
      const newRecipient = new Recipient({
        email: ${JSON.stringify(email)},
        name: ${JSON.stringify(name || "")},
        raw: ${JSON.stringify(name ? `${name} <${email}>` : email)},
      });

      const existingTo = draft.to || [];
      ctrl._updateDraft({ to: [...existingTo, newRecipient] });
      return true;
    `
  );
  return result === true;
}

/**
 * Set the body of the current draft
 */
export async function setBody(
  conn: SuperhumanConnection,
  html: string
): Promise<boolean> {
  const result = await withDraftController<boolean>(
    conn,
    `
      if (typeof ctrl._updateDraft !== 'function') return false;
      ctrl._updateDraft({ body: ${JSON.stringify(html)} });
      return true;
    `
  );
  return result === true;
}

/**
 * Save the current draft
 */
export async function saveDraft(conn: SuperhumanConnection): Promise<boolean> {
  const result = await withDraftController<boolean>(
    conn,
    `
      if (typeof ctrl._saveDraftAsync !== 'function') return false;
      ctrl._saveDraftAsync();
      return true;
    `
  );

  await new Promise((r) => setTimeout(r, 2000));
  return result === true;
}

/**
 * Close the compose form
 */
export async function closeCompose(conn: SuperhumanConnection): Promise<void> {
  const { Input } = conn;

  await Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape" });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
  await new Promise((r) => setTimeout(r, 500));
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
export async function sendDraft(conn: SuperhumanConnection): Promise<boolean> {
  const result = await withDraftController<boolean>(
    conn,
    `
      if (typeof ctrl._sendDraft !== 'function') return false;
      ctrl._sendDraft();
      return true;
    `
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
