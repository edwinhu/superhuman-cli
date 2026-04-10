#!/usr/bin/env bun
/**
 * Use Superhuman's REAL compose flow to send programmatically.
 *
 * Instead of constructing a duck-typed OutgoingMessage, this script:
 * 1. Opens compose via ViewState (same as Cmd+N)
 * 2. Fills in the fields via the compose form controller
 * 3. Triggers send via the real controller method
 *
 * This will definitively tell us if the payload format is the issue.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Test Real Compose & Send Flow");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime } = client;

  // 1. Check if there's already a compose open and use it, or examine the
  //    compose flow to understand what we need
  console.log("\n1. Exploring compose flow");
  console.log("-".repeat(40));

  const composeExplore = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const di = ga?.di;
        const backend = ga?.backend;

        // Check ViewState for compose methods
        const vs = window.ViewState;
        if (!vs) return { error: "No ViewState" };

        const vsKeys = Object.keys(vs).filter(k =>
          k.includes('compose') || k.includes('Compose') ||
          k.includes('draft') || k.includes('Draft') ||
          k.includes('send') || k.includes('Send')
        );

        // Check if compose form controller exists
        const cfc = vs._composeFormController;
        const cfcKeys = cfc ? Object.keys(cfc) : [];

        // Look for methods to open compose
        let vsMethods = [];
        let proto = Object.getPrototypeOf(vs);
        while (proto && proto !== Object.prototype) {
          for (const name of Object.getOwnPropertyNames(proto)) {
            if (typeof vs[name] === 'function' &&
                (name.includes('compose') || name.includes('Compose') ||
                 name.includes('draft') || name.includes('Draft'))) {
              vsMethods.push(name);
            }
          }
          proto = Object.getPrototypeOf(proto);
        }

        return {
          vsKeys,
          cfcKeys,
          vsMethods,
          hasCfc: !!cfc,
        };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(composeExplore.result.value, null, 2));

  // 2. Try to find what the real OutgoingMessage class produces
  // Let's look at the source code for the real class
  console.log("\n2. Finding OutgoingMessage class via the app's module system");
  console.log("-".repeat(40));

  const findClass = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const di = ga?.di;

        // Try to create a compose
        // First try ViewState.compose()
        const vs = window.ViewState;

        // Method: use DraftStore or ComposeService
        // Look for draft-related services in DI
        let draftStoreClass = null;
        let composeServiceClass = null;

        // Try to find via ga.labels or ga.threads
        const labels = ga?.labels;
        const threads = ga?.threads;

        // Check ga for draft-related methods
        let gaMethods = [];
        let gaProto = Object.getPrototypeOf(ga);
        while (gaProto && gaProto !== Object.prototype) {
          for (const name of Object.getOwnPropertyNames(gaProto)) {
            if (typeof ga[name] === 'function' &&
                (name.includes('draft') || name.includes('Draft') ||
                 name.includes('compose') || name.includes('Compose') ||
                 name.includes('outgoing') || name.includes('Outgoing') ||
                 name.includes('send') || name.includes('Send'))) {
              gaMethods.push({ name, src: ga[name].toString().substring(0, 200) });
            }
          }
          gaProto = Object.getPrototypeOf(gaProto);
        }

        return { gaMethods };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(findClass.result.value, null, 2));

  // 3. Try to open compose programmatically and examine the draft
  console.log("\n3. Open compose and examine draft");
  console.log("-".repeat(40));

  const openCompose = await Runtime.evaluate({
    expression: `
      (async () => {
        const vs = window.ViewState;

        // Try keyboard shortcut simulation - press 'c' which opens compose in Superhuman
        // Or find the compose method

        // Check if there's an existing compose form
        const cfc = vs?._composeFormController;
        if (cfc) {
          const keys = Object.keys(cfc);
          if (keys.length > 0) {
            const draftKey = keys.find(k => k.startsWith('draft'));
            if (draftKey) {
              const ctrl = cfc[draftKey];
              const draft = ctrl?.state?.draft;
              if (draft) {
                // We have a draft! Look at its asMessage output WITH di
                const ga = window.GoogleAccount;
                const di = ga?.di;
                const msg = draft.asMessage(di);

                // Get the REAL toJsonRequest output
                const jsonReq = msg?.toJsonRequest?.();

                // Also get the class name and prototype methods
                let methods = [];
                if (msg) {
                  let proto = Object.getPrototypeOf(msg);
                  while (proto && proto !== Object.prototype) {
                    for (const name of Object.getOwnPropertyNames(proto)) {
                      if (typeof msg[name] === 'function') {
                        methods.push(name);
                      }
                    }
                    proto = Object.getPrototypeOf(proto);
                  }
                }

                return {
                  hasDraft: true,
                  className: msg?.constructor?.name,
                  methods,
                  toJsonRequest: jsonReq,
                  toJsonRequestKeys: jsonReq ? Object.keys(jsonReq) : null,
                };
              }
            }
          }
        }

        // No compose open. Let's try to create one via the action runner
        // Try to find the compose action
        const actions = vs?._actions || vs?.actions;
        if (actions) {
          const composeAction = Object.keys(actions).find(k =>
            k.includes('compose') || k.includes('Compose'));
          return { noCompose: true, actions: Object.keys(actions).slice(0, 20) };
        }

        // Try Cmd+N equivalent
        return { noCompose: true, note: "Please open compose manually (Cmd+N in Superhuman)" };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(openCompose.result.value, null, 2));

  // 4. Let's examine the sendEmail source more carefully for retry logic
  console.log("\n4. Detailed sendEmail analysis");
  console.log("-".repeat(40));

  const sendAnalysis = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;

        // Get the complete sendEmail source
        const sendEmailSrc = backend?.sendEmail?.toString();

        // Get the fetch method to understand retry
        const fetchSrc = backend?.fetch?.toString();

        // Get SEND_DELAY
        // From sendEmail source: delay: se.SEND_DELAY
        // Let's try to eval it in the closure scope
        // Actually let's search for it in the backend
        let sendDelay = null;

        // Check if there's a profiler/measure on the catrin check
        // The sendEmail method has a special case for catrin@aenu.com
        // This suggests version 3 payload IS the right format

        return {
          sendEmailSrc,
          // The key info: what does toJsonRequest need to produce?
          note: "sendEmail only calls r.toJsonRequest() to get payload. The 520 may be server-side validation of the payload content.",
        };
      })()
    `,
    returnByValue: true,
  });

  console.log("sendEmail source:");
  console.log(sendAnalysis.result.value.sendEmailSrc);

  await client.close();
  console.log("\nDone.");
  console.log("\n\nTo capture a real send, open compose (Cmd+N), compose to ehu@law.virginia.edu, and send (Cmd+Enter).");
  console.log("The background capture-real-send2.ts script should capture it.");
}

main().catch(console.error);
