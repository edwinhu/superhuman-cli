#!/usr/bin/env bun
/**
 * Examine the REAL draft created by Superhuman's compose UI
 * and compare its toJsonRequest() with our mock.
 * Then try to send using the controller's own send method.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function sleep(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("Examine Real Draft & Send");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime, Network, Input } = client;
  await Network.enable();

  // Set up network capture
  const capturedRequests: any[] = [];
  const capturedResponses: any[] = [];

  Network.requestWillBeSent((params: any) => {
    if (params.request.url.includes("messages/send") ||
        params.request.url.includes("userdata.writeMessage")) {
      capturedRequests.push({
        url: params.request.url,
        method: params.request.method,
        postData: params.request.postData,
      });
    }
  });

  Network.responseReceived(async (params: any) => {
    if (params.response.url.includes("messages/send") && !params.response.url.includes("/log")) {
      let body = "";
      try {
        const result = await Network.getResponseBody({ requestId: params.requestId });
        body = result.body?.substring(0, 2000) || "";
      } catch {}
      capturedResponses.push({ status: params.response.status, body, url: params.response.url });
    }
  });

  // 1. Fill in the compose draft
  console.log("\n1. Filling compose draft with To, Subject, Body...");
  console.log("-".repeat(40));

  const fillResult = await Runtime.evaluate({
    expression: `
      (() => {
        const vs = window.ViewState;
        const cfc = vs?._composeFormController;
        const keys = Object.keys(cfc || {});
        if (keys.length === 0) return { error: "No compose open" };

        const draftKey = keys.find(k => k.startsWith('draft'));
        const ctrl = cfc[draftKey];
        if (!ctrl) return { error: "No controller for " + draftKey };

        // Get the draft
        const draft = ctrl.state?.draft;
        if (!draft) return { error: "No draft state" };

        // Examine draft attributes
        const attrs = draft.attributes || {};

        // Get available methods on the controller
        let ctrlMethods = [];
        let proto = Object.getPrototypeOf(ctrl);
        while (proto && proto !== Object.prototype) {
          for (const name of Object.getOwnPropertyNames(proto)) {
            if (typeof ctrl[name] === 'function') {
              ctrlMethods.push(name);
            }
          }
          proto = Object.getPrototypeOf(proto);
        }

        // Get methods related to setting fields
        const relevantMethods = ctrlMethods.filter(m =>
          m.includes('set') || m.includes('Set') ||
          m.includes('update') || m.includes('Update') ||
          m.includes('send') || m.includes('Send') ||
          m.includes('submit') || m.includes('Submit') ||
          m.includes('to') || m.includes('To') ||
          m.includes('subject') || m.includes('Subject') ||
          m.includes('body') || m.includes('Body')
        );

        return {
          draftKey,
          attrs: {
            id: attrs.id,
            threadId: attrs.threadId,
            action: attrs.action,
            from: attrs.from,
            to: attrs.to,
            subject: attrs.subject,
            body: attrs.body?.substring(0, 200),
          },
          ctrlMethods: relevantMethods,
          allMethods: ctrlMethods,
        };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(fillResult.result.value, null, 2));

  // 2. Update the draft to add recipient and subject
  console.log("\n2. Setting draft fields...");
  console.log("-".repeat(40));

  const updateDraft = await Runtime.evaluate({
    expression: `
      (() => {
        const vs = window.ViewState;
        const cfc = vs?._composeFormController;
        const keys = Object.keys(cfc || {});
        const draftKey = keys.find(k => k.startsWith('draft'));
        const ctrl = cfc[draftKey];
        const draft = ctrl?.state?.draft;

        if (!draft) return { error: "No draft" };

        // Set the draft fields directly
        draft.attributes = draft.attributes || {};
        draft.set('to', ['ehu@law.virginia.edu']);
        draft.set('subject', 'Real compose test ' + new Date().toISOString().substring(11,19));
        draft.set('body', '<div>Test via real compose flow</div>');

        // Verify
        return {
          to: draft.attributes.to || draft.get?.('to'),
          subject: draft.attributes.subject || draft.get?.('subject'),
          body: (draft.attributes.body || draft.get?.('body'))?.substring(0, 100),
        };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(updateDraft.result.value, null, 2));

  // 3. Get the REAL toJsonRequest output
  console.log("\n3. REAL toJsonRequest() output");
  console.log("-".repeat(40));

  const realPayload = await Runtime.evaluate({
    expression: `
      (() => {
        const vs = window.ViewState;
        const ga = window.GoogleAccount;
        const di = ga?.di;
        const cfc = vs?._composeFormController;
        const keys = Object.keys(cfc || {});
        const draftKey = keys.find(k => k.startsWith('draft'));
        const ctrl = cfc[draftKey];
        const draft = ctrl?.state?.draft;

        if (!draft) return { error: "No draft" };

        // Get the real OutgoingMessage
        const msg = draft.asMessage(di);
        if (!msg) return { error: "asMessage returned null" };

        // Get toJsonRequest
        const jsonReq = msg.toJsonRequest();

        return {
          className: msg.constructor?.name,
          toJsonRequest: jsonReq,
          toJsonRequestKeys: Object.keys(jsonReq),
        };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(realPayload.result.value, null, 2));

  // 4. Now try to send using the controller's own submit/send method
  console.log("\n4. Looking for controller send method...");
  console.log("-".repeat(40));

  const sendMethods = await Runtime.evaluate({
    expression: `
      (() => {
        const vs = window.ViewState;
        const cfc = vs?._composeFormController;
        const keys = Object.keys(cfc || {});
        const draftKey = keys.find(k => k.startsWith('draft'));
        const ctrl = cfc[draftKey];

        if (!ctrl) return { error: "No controller" };

        // Get ALL methods
        let methods = [];
        let proto = Object.getPrototypeOf(ctrl);
        while (proto && proto !== Object.prototype) {
          for (const name of Object.getOwnPropertyNames(proto)) {
            if (typeof ctrl[name] === 'function') {
              methods.push(name);
            }
          }
          proto = Object.getPrototypeOf(proto);
        }

        // Find send-related methods
        const sendRelated = methods.filter(m =>
          m.toLowerCase().includes('send') ||
          m.toLowerCase().includes('submit') ||
          m.toLowerCase().includes('dispatch')
        );

        // Look for props.run or props.onSend
        const props = ctrl.props || {};
        const propsKeys = Object.keys(props);
        const propFunctions = propsKeys.filter(k => typeof props[k] === 'function');

        return {
          sendRelated,
          propFunctions,
          allMethods: methods,
        };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(sendMethods.result.value, null, 2));

  // 5. Try to use ViewState.run to trigger send
  console.log("\n5. Trying ViewState.run for send...");
  console.log("-".repeat(40));

  const runResult = await Runtime.evaluate({
    expression: `
      (() => {
        const vs = window.ViewState;

        // Get run method source
        const runSrc = vs?.run?.toString()?.substring(0, 2000);

        // Check what actions run() can accept
        return {
          runSrc,
        };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(runResult.result.value, null, 2));

  // 6. Try the most promising approach: call the send action through run()
  console.log("\n6. Attempting send via ViewState.run('send')...");
  console.log("-".repeat(40));

  const sendAttempt = await Runtime.evaluate({
    expression: `
      (async () => {
        const vs = window.ViewState;
        const ga = window.GoogleAccount;

        try {
          // Try calling run with 'send' action
          // First, let's see what actions are available
          const result = await vs.run('send');
          return { success: true, result };
        } catch (e) {
          return { error: e.message, stack: e.stack?.substring(0, 300) };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(sendAttempt.result.value, null, 2));

  // Wait for network
  await sleep(3000);

  // 7. Try Cmd+Enter via keydown event dispatch on the compose element
  console.log("\n7. Trying Cmd+Enter via keydown dispatch...");
  console.log("-".repeat(40));

  // Focus the page first
  await client.Page.bringToFront();
  await sleep(500);

  // Try dispatching key events
  await Input.dispatchKeyEvent({
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: 4, // Meta (Cmd) key
  });
  await Input.dispatchKeyEvent({
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: 4,
  });

  await sleep(5000);

  // 8. Show all captured traffic
  console.log("\n" + "=".repeat(60));
  console.log("ALL CAPTURED NETWORK TRAFFIC");
  console.log("=".repeat(60));

  for (const req of capturedRequests) {
    console.log(`\n${req.method} ${req.url}`);
    if (req.postData) {
      try {
        console.log(JSON.stringify(JSON.parse(req.postData), null, 2).substring(0, 3000));
      } catch {
        console.log(req.postData.substring(0, 1000));
      }
    }
  }

  for (const resp of capturedResponses) {
    console.log(`\nRESPONSE ${resp.status} ${resp.url}`);
    console.log(`Body: ${resp.body}`);
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
