#!/usr/bin/env bun
/**
 * Trigger compose and send via Superhuman's internal JS APIs.
 * Also try to understand what SEND_DELAY is and examine the full
 * sendEmail flow more carefully.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function sleep(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("Trigger Compose via JS API");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime, Network } = client;
  await Network.enable();

  // Set up network capture
  const capturedRequests: any[] = [];
  Network.requestWillBeSent((params: any) => {
    if (params.request.url.includes("messages/send") || params.request.url.includes("userdata.writeMessage")) {
      capturedRequests.push({
        url: params.request.url,
        method: params.request.method,
        postData: params.request.postData,
      });
    }
  });
  const capturedResponses: any[] = [];
  Network.responseReceived(async (params: any) => {
    if (params.response.url.includes("messages/send")) {
      let body = "";
      try {
        const result = await Network.getResponseBody({ requestId: params.requestId });
        body = result.body?.substring(0, 2000) || "";
      } catch {}
      capturedResponses.push({ status: params.response.status, body, url: params.response.url });
    }
  });

  // 1. Try to find the action runner / command system
  console.log("\n1. Finding compose trigger...");
  console.log("-".repeat(40));

  const trigger = await Runtime.evaluate({
    expression: `
      (() => {
        // Look for ActionRunner, CommandPalette, or similar
        const vs = window.ViewState;
        const ga = window.GoogleAccount;

        // Check for run/dispatch/execute methods
        let methods = [];
        for (const obj of [vs, ga]) {
          if (!obj) continue;
          let proto = Object.getPrototypeOf(obj);
          while (proto && proto !== Object.prototype) {
            for (const name of Object.getOwnPropertyNames(proto)) {
              if (typeof obj[name] === 'function' &&
                  (name === 'run' || name === 'dispatch' || name === 'execute' ||
                   name.includes('action') || name.includes('Action'))) {
                methods.push({ obj: obj === vs ? 'ViewState' : 'GoogleAccount', name });
              }
            }
            proto = Object.getPrototypeOf(proto);
          }
        }

        // Look for keyboard handler or action map
        let keymap = null;
        try {
          // Common pattern: window._keyboardHandler or similar
          const kh = vs?._keyboardHandler || vs?._actionRunner || vs?._dispatcher;
          if (kh) {
            keymap = {
              type: typeof kh,
              keys: Object.keys(kh).slice(0, 20),
            };
          }
        } catch {}

        // Check for React-based stores
        let storeKeys = [];
        try {
          // Look for flux stores/dispatchers
          for (const key of Object.keys(window)) {
            if (key.includes('Store') || key.includes('Dispatcher') || key.includes('Actions')) {
              storeKeys.push(key);
            }
          }
        } catch {}

        return { methods, keymap, storeKeys: storeKeys.slice(0, 20) };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(trigger.result.value, null, 2));

  // 2. Try to create compose via DOM click or Superhuman's internal dispatch
  console.log("\n2. Trying to create compose via internal API...");
  console.log("-".repeat(40));

  const createCompose = await Runtime.evaluate({
    expression: `
      (async () => {
        const vs = window.ViewState;
        const ga = window.GoogleAccount;

        // Method 1: Try to click the compose button if visible
        const composeBtn = document.querySelector('[data-testid="compose-button"]') ||
                          document.querySelector('[aria-label*="Compose"]') ||
                          document.querySelector('[aria-label*="compose"]') ||
                          document.querySelector('button[class*="compose"]');

        if (composeBtn) {
          composeBtn.click();
          return { method: "click", element: composeBtn.tagName };
        }

        // Method 2: Try ViewState methods
        if (typeof vs?.profileCreatingDraft === 'function') {
          // This doesn't create a draft, it just starts profiling
        }

        // Method 3: Dispatch keyboard event to the document
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          keyCode: 67,
          which: 67,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(event);

        // Wait a moment
        await new Promise(r => setTimeout(r, 1000));

        // Check if compose opened
        const cfc = vs?._composeFormController;
        const keys = cfc ? Object.keys(cfc) : [];

        if (keys.length > 0) {
          return { method: "keyboard", keys };
        }

        // Method 4: Try finding the compose handler in React internals
        // Look for React fiber root
        const rootEl = document.getElementById('root') || document.getElementById('app') ||
                       document.querySelector('[data-reactroot]');
        if (rootEl) {
          const fiberKey = Object.keys(rootEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
          if (fiberKey) {
            return { method: "react", hasFiber: true, note: "Could traverse React fiber tree" };
          }
        }

        return { method: "none", composeOpenKeys: keys };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(createCompose.result.value, null, 2));

  // 3. Check if compose opened
  await sleep(2000);
  const checkCompose = await Runtime.evaluate({
    expression: `
      (() => {
        const cfc = window.ViewState?._composeFormController;
        return { keys: Object.keys(cfc || {}) };
      })()
    `,
    returnByValue: true,
  });
  console.log("Compose form controller keys:", checkCompose.result.value);

  // 4. Let's try a completely different angle: look at what SEND_DELAY is
  // and examine the full request more carefully
  console.log("\n3. SEND_DELAY and full request examination");
  console.log("-".repeat(40));

  const delayAnalysis = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;

        // Try to find SEND_DELAY by examining sendEmail's closure
        // The variable name in minified code is 'se.SEND_DELAY'
        // se is likely the module/namespace containing constants

        // Try to get it by calling sendEmail with a mock that records the delay
        let capturedPayload = null;
        const origFetch = backend.fetch;

        backend.fetch = function(url, opts) {
          if (url.includes('messages/send')) {
            capturedPayload = {
              url,
              opts: { ...opts },
              bodyParsed: opts?.body ? JSON.parse(opts.body) : null,
            };
          }
          // Don't actually send
          return Promise.reject(new Error('mock'));
        };

        const mockMsg = {
          toJsonRequest: () => ({ test: true }),
          getSubject: () => "test",
          getSuperhumanId: () => "test",
          getThreadId: () => "test",
          getMessageId: () => "test",
        };

        try {
          backend.sendEmail(mockMsg);
        } catch {}

        // Restore
        backend.fetch = origFetch;

        return capturedPayload;
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(delayAnalysis.result.value, null, 2));

  // 5. Important: Check if the 520 error includes any details in dev mode
  console.log("\n4. Checking if 520 has more details...");
  console.log("-".repeat(40));

  const errorDetails = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;

        // Try to send with a minimal valid payload and capture the full error
        const mockMsg = {
          toJsonRequest: () => ({
            headers: [],
            superhuman_id: crypto.randomUUID(),
            rfc822_id: '<test@test.com>',
            thread_id: 'draft00test',
            message_id: 'draft00test',
            in_reply_to: null,
            from: 'eddyhu@gmail.com',
            to: ['ehu@law.virginia.edu'],
            cc: [],
            bcc: [],
            subject: 'Test',
            html_body: '<div>Test</div>',
            attachments: [],
            scheduled_for: null,
            abort_on_reply: false,
            current_message_ids: ['draft00test'],
            mail_merge_recipients: [],
          }),
          getSubject: () => "Test",
          getSuperhumanId: () => "test-id",
          getThreadId: () => "draft00test",
          getMessageId: () => "draft00test",
        };

        try {
          await backend.sendEmail(mockMsg);
          return { success: true };
        } catch (e) {
          return {
            error: e.message,
            code: e.code,
            status: e.status,
            statusCode: e.statusCode,
            response: e.response?.substring?.(0, 500),
            name: e.name,
            detail: e.detail,
            fullError: JSON.stringify(e, Object.getOwnPropertyNames(e)).substring(0, 1000),
          };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(errorDetails.result.value, null, 2));

  // 5. Final check: see if the error reveals response headers
  await sleep(2000);

  console.log("\n5. Captured requests/responses:");
  console.log("-".repeat(40));
  for (const req of capturedRequests) {
    console.log(`  ${req.method} ${req.url}`);
    if (req.postData && req.url.includes("messages/send")) {
      console.log("  Body:", req.postData.substring(0, 2000));
    }
  }
  for (const resp of capturedResponses) {
    console.log(`  ${resp.status} ${resp.url} → ${resp.body}`);
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
