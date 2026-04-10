#!/usr/bin/env bun
/**
 * Compare the browser's send payload with our CLI's payload.
 * Also test calling backend.sendEmail() directly from browser context.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Compare Send Payloads");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime, Network } = client;
  await Network.enable();

  // 1. Compose a draft in the browser and get toJsonRequest() output
  console.log("\n1. Getting browser's toJsonRequest() from an open compose");
  console.log("-".repeat(40));

  const browserPayload = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const cfc = window.ViewState?._composeFormController;

          if (!cfc) return { error: "No compose form controller - is compose window open?" };

          const draftKey = Object.keys(cfc || {}).find(k => k.startsWith('draft'));
          if (!draftKey) return { error: "No draft found - open compose first (Cmd+N)" };

          const ctrl = cfc[draftKey];
          const draft = ctrl?.state?.draft;

          if (!draft) return { error: "No draft state" };

          // Get the message via asMessage(di)
          const msg = draft.asMessage(di);
          if (!msg) return { error: "asMessage returned null" };

          // Get toJsonRequest
          const jsonReq = msg.toJsonRequest();

          // Also get SEND_DELAY from the module
          // The sendEmail method references se.SEND_DELAY
          // Try to find it in the backend
          let sendDelay = null;
          try {
            // SEND_DELAY is typically in the module scope, but we can read it
            // from the sendEmail source
            const src = ga.backend?.sendEmail?.toString() || "";
            const match = src.match(/delay:\\s*([a-zA-Z_.]+)/);
            sendDelay = match ? match[1] : "unknown";
          } catch {}

          return {
            toJsonRequest: jsonReq,
            toJsonRequestKeys: Object.keys(jsonReq),
            sendDelayRef: sendDelay,
            draftAction: draft.attributes?.action,
            draftId: draft.attributes?.id,
            draftThreadId: draft.attributes?.threadId,
          };
        } catch (e) {
          return { error: e.message, stack: e.stack?.substring(0, 500) };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  const payload = browserPayload.result.value;
  if (payload.error) {
    console.log("ERROR:", payload.error);
    console.log("\nPlease open Compose in Superhuman (Cmd+N), type a test message to ehu@law.virginia.edu, then re-run this script.");
    await client.close();
    process.exit(1);
  }

  console.log("Browser toJsonRequest keys:", payload.toJsonRequestKeys);
  console.log("\nFull toJsonRequest:");
  console.log(JSON.stringify(payload.toJsonRequest, null, 2));
  console.log("\nSEND_DELAY reference:", payload.sendDelayRef);

  // 2. Now build what our CLI would send and compare
  console.log("\n\n2. Comparing with CLI payload");
  console.log("-".repeat(40));

  const browserMsg = payload.toJsonRequest;

  // Our CLI constructs this in sendDraftSuperhuman():
  const cliMsg = {
    headers: [
      { name: "X-Mailer", value: "Superhuman Web (2026-04-03T19:06:01Z)" },
      { name: "X-Superhuman-ID", value: "cli-test-id" },
      { name: "X-Superhuman-Draft-ID", value: payload.draftId || "draft00test" },
      { name: "X-Superhuman-Thread-ID", value: payload.draftThreadId || "draft00test" },
    ],
    superhuman_id: "cli-test-id",
    rfc822_id: "<test@we.are.superhuman.com>",
    thread_id: payload.draftThreadId,
    message_id: payload.draftId,
    in_reply_to: null,
    from: browserMsg.from, // match browser
    to: browserMsg.to,
    cc: browserMsg.cc || [],
    bcc: browserMsg.bcc || [],
    subject: browserMsg.subject,
    html_body: browserMsg.html_body,
    attachments: [],
    scheduled_for: null,
    abort_on_reply: false,
    current_message_ids: [payload.draftId],
    mail_merge_recipients: [],
  };

  // Find fields in browser payload but not in CLI
  const browserKeys = new Set(Object.keys(browserMsg));
  const cliKeys = new Set(Object.keys(cliMsg));

  const inBrowserNotCli = [...browserKeys].filter(k => !cliKeys.has(k));
  const inCliNotBrowser = [...cliKeys].filter(k => !browserKeys.has(k));

  console.log("Fields in BROWSER but NOT in CLI:", inBrowserNotCli);
  console.log("Fields in CLI but NOT in BROWSER:", inCliNotBrowser);

  // 3. Try to actually send via backend.sendEmail() from the browser context
  // This proves whether the issue is auth/headers or payload
  console.log("\n\n3. Test: Call backend.sendEmail() directly from browser");
  console.log("-".repeat(40));
  console.log("(This bypasses our CLI's HTTP call and uses the browser's own fetch)");

  // Install a fetch interceptor to capture what gets sent
  const sendTest = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const backend = ga?.backend;

          // Intercept fetch to capture the exact request
          const origFetch = window._originalFetch || window.fetch;
          let capturedReq = null;

          window.fetch = function(resource, init) {
            const url = typeof resource === 'string' ? resource : resource?.url || '';
            if (url.includes('messages/send') && !url.includes('/log')) {
              capturedReq = {
                url: url.substring(0, 200),
                method: init?.method,
                bodyParsed: init?.body ? JSON.parse(init.body) : null,
              };
            }
            return origFetch.apply(this, arguments);
          };

          // Get the compose form controller
          const cfc = window.ViewState?._composeFormController;
          const draftKey = Object.keys(cfc || {}).find(k => k.startsWith('draft'));
          const ctrl = cfc?.[draftKey];
          const draft = ctrl?.state?.draft;

          if (!draft) return { error: "No draft" };

          // Build the outgoing message
          const msg = draft.asMessage(di);
          if (!msg) return { error: "asMessage failed" };

          // Call sendEmail
          try {
            const result = await backend.sendEmail(msg);
            window.fetch = origFetch;
            return {
              success: true,
              result: result,
              capturedRequest: capturedReq,
            };
          } catch (e) {
            window.fetch = origFetch;
            return {
              success: false,
              error: e.message,
              capturedRequest: capturedReq,
            };
          }
        } catch (e) {
          return { error: e.message, stack: e.stack?.substring(0, 500) };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(sendTest.result.value, null, 2));

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
