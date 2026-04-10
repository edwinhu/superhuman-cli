#!/usr/bin/env bun
/**
 * Trigger Compose & Send via CDP keyboard simulation.
 * Opens compose, fills to/subject/body, and sends via Cmd+Enter.
 * Then captures the network traffic.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function sleep(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

async function typeText(Input: any, text: string) {
  for (const char of text) {
    await Input.dispatchKeyEvent({ type: "keyDown", key: char, text: char });
    await Input.dispatchKeyEvent({ type: "keyUp", key: char });
    await sleep(30);
  }
}

async function pressKey(Input: any, key: string, modifiers = 0) {
  await Input.dispatchKeyEvent({ type: "keyDown", key, modifiers });
  await Input.dispatchKeyEvent({ type: "keyUp", key, modifiers });
}

async function main() {
  console.log("Trigger Compose & Send via CDP");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime, Input, Network } = client;
  await Network.enable();

  // Set up network capture for messages/send
  const capturedRequests: any[] = [];
  const capturedResponses: any[] = [];

  Network.requestWillBeSent((params: any) => {
    if (params.request.url.includes("messages/send") || params.request.url.includes("userdata.writeMessage")) {
      capturedRequests.push({
        url: params.request.url,
        method: params.request.method,
        postData: params.request.postData,
        timestamp: new Date().toISOString(),
      });
    }
  });

  Network.responseReceived(async (params: any) => {
    if (params.response.url.includes("messages/send") || params.response.url.includes("userdata.writeMessage")) {
      let body = "";
      try {
        const result = await Network.getResponseBody({ requestId: params.requestId });
        body = result.body?.substring(0, 2000) || "";
      } catch {}

      capturedResponses.push({
        url: params.response.url,
        status: params.response.status,
        body,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Step 1: Open compose with 'c' key
  console.log("\n1. Opening compose (pressing 'c')...");
  await pressKey(Input, "c");
  await sleep(2000);

  // Step 2: Type recipient
  console.log("2. Typing recipient...");
  await typeText(Input, "ehu@law.virginia.edu");
  await sleep(500);

  // Press Tab to move to subject (or Enter to confirm autocomplete)
  await pressKey(Input, "Tab");
  await sleep(500);

  // Press Tab again to skip CC/BCC
  await pressKey(Input, "Tab");
  await sleep(300);

  // Step 3: Type subject
  console.log("3. Typing subject...");
  const subject = `CDP compose test ${new Date().toISOString().substring(11, 19)}`;
  await typeText(Input, subject);
  await sleep(300);

  // Tab to body
  await pressKey(Input, "Tab");
  await sleep(300);

  // Step 4: Type body
  console.log("4. Typing body...");
  await typeText(Input, "This is a test email sent via CDP compose simulation.");
  await sleep(1000);

  // Step 5: Capture the draft state before sending
  console.log("5. Capturing draft state...");
  const draftState = await Runtime.evaluate({
    expression: `
      (() => {
        const vs = window.ViewState;
        const cfc = vs?._composeFormController;
        if (!cfc) return { error: "No compose form controller" };

        const keys = Object.keys(cfc);
        const draftKey = keys.find(k => k.startsWith('draft'));
        if (!draftKey) return { error: "No draft found", keys };

        const ctrl = cfc[draftKey];
        const draft = ctrl?.state?.draft;
        if (!draft) return { error: "No draft state" };

        // Get the real OutgoingMessage
        const ga = window.GoogleAccount;
        const di = ga?.di;
        const msg = draft.asMessage(di);
        const jsonReq = msg?.toJsonRequest?.();

        return {
          draftId: draft.attributes?.id || draftKey,
          threadId: draft.attributes?.threadId,
          toJsonRequest: jsonReq,
          toJsonRequestKeys: jsonReq ? Object.keys(jsonReq) : null,
          className: msg?.constructor?.name,
        };
      })()
    `,
    returnByValue: true,
  });

  console.log("Draft state:", JSON.stringify(draftState.result.value, null, 2));

  // Step 6: Send with Cmd+Enter
  console.log("\n6. Sending with Cmd+Enter...");
  // metaKey (Cmd on Mac) = modifier bit 4 = 4
  await Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", modifiers: 4 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", modifiers: 4 });

  // Wait for network traffic
  console.log("7. Waiting for network traffic...");
  await sleep(5000);

  // Step 7: Display captured traffic
  console.log("\n" + "=".repeat(60));
  console.log("CAPTURED NETWORK TRAFFIC");
  console.log("=".repeat(60));

  console.log(`\nRequests (${capturedRequests.length}):`);
  for (const req of capturedRequests) {
    console.log(`\n  ${req.method} ${req.url}`);
    if (req.postData) {
      try {
        const body = JSON.parse(req.postData);
        console.log("  Body:", JSON.stringify(body, null, 2).substring(0, 3000));
      } catch {
        console.log("  Body:", req.postData.substring(0, 1000));
      }
    }
  }

  console.log(`\nResponses (${capturedResponses.length}):`);
  for (const resp of capturedResponses) {
    console.log(`\n  ${resp.status} ${resp.url}`);
    console.log(`  Body: ${resp.body}`);
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
