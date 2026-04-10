#!/usr/bin/env bun
/**
 * Use CDP to control the browser and actually send an email.
 * Captures the exact network traffic to see the real messages/send payload.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function sleep(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("CDP Browser-Controlled Compose & Send");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime, Input, Network, Page } = client;
  await Network.enable();

  // Capture ALL network traffic for messages/send
  const capturedRequests: any[] = [];
  const capturedResponses: any[] = [];
  const requestIdToUrl = new Map<string, string>();

  Network.requestWillBeSent((params: any) => {
    const { url, method, headers, postData } = params.request;
    if (url.includes("messages/send") || url.includes("userdata.writeMessage")) {
      requestIdToUrl.set(params.requestId, url);
      capturedRequests.push({
        url,
        method,
        headers: Object.fromEntries(
          Object.entries(headers as Record<string, string>).map(([k, v]) => [
            k,
            k.toLowerCase() === "authorization"
              ? `Bearer <JWT truncated>`
              : k.toLowerCase() === "cookie"
              ? `<${v.length} chars>`
              : v,
          ])
        ),
        postData,
      });
      console.log(`  [REQ] ${method} ${url.substring(url.lastIndexOf("/") - 10)}`);
    }
  });

  Network.responseReceived(async (params: any) => {
    const url = requestIdToUrl.get(params.requestId);
    if (!url || url.includes("/log")) return;

    let body = "";
    try {
      const result = await Network.getResponseBody({ requestId: params.requestId });
      body = result.body?.substring(0, 2000) || "";
    } catch {}
    capturedResponses.push({ status: params.response.status, body, url });
    console.log(`  [RESP] ${params.response.status} ${url.substring(url.lastIndexOf("/") - 10)}`);
  });

  // Also monitor the service worker
  const sw = targets.find((t: any) => t.type === "service_worker");
  let swClient: any = null;
  if (sw) {
    swClient = await CDP({ target: sw.id, port: CDP_PORT, host });
    await swClient.Network.enable();

    swClient.Network.requestWillBeSent((params: any) => {
      const { url, method, headers, postData } = params.request;
      if (url.includes("messages/send")) {
        capturedRequests.push({ url, method, headers, postData, source: "sw" });
        console.log(`  [SW-REQ] ${method} ${url.substring(url.lastIndexOf("/") - 10)}`);
      }
    });

    swClient.Network.responseReceived(async (params: any) => {
      if (!params.response.url.includes("messages/send")) return;
      let body = "";
      try {
        const result = await swClient.Network.getResponseBody({ requestId: params.requestId });
        body = result.body || "";
      } catch {}
      capturedResponses.push({ status: params.response.status, body, url: params.response.url, source: "sw" });
      console.log(`  [SW-RESP] ${params.response.status}`);
    });
  }

  // Step 1: Bring page to front
  console.log("\n1. Bringing Superhuman to front...");
  await Page.bringToFront();
  await sleep(1000);

  // Step 2: Make sure we're on the right account
  console.log("2. Checking current account...");
  const account = await Runtime.evaluate({
    expression: `window.GoogleAccount?.emailAddress`,
    returnByValue: true,
  });
  console.log(`   Current account: ${account.result.value}`);

  // Step 3: Press Escape first to clear any existing state
  console.log("3. Clearing state (Escape)...");
  await Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
  await sleep(500);

  // Step 4: Open compose with 'c'
  console.log("4. Opening compose (pressing 'c')...");
  await Input.dispatchKeyEvent({ type: "char", text: "c", key: "c", code: "KeyC", windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 });
  await sleep(2000);

  // Step 5: Check if compose opened
  const composCheck = await Runtime.evaluate({
    expression: `Object.keys(window.ViewState?._composeFormController || {})`,
    returnByValue: true,
  });
  console.log(`   Compose keys: ${JSON.stringify(composCheck.result.value)}`);

  if (composCheck.result.value.length === 0) {
    console.log("   Compose didn't open. Trying focus + keypress...");
    // Try clicking on the page first
    await Runtime.evaluate({ expression: `document.body.focus()` });
    await sleep(300);

    // Try dispatching via DOM events
    await Runtime.evaluate({
      expression: `
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', keyCode: 67, which: 67, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keypress', { key: 'c', code: 'KeyC', keyCode: 67, which: 67, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'c', code: 'KeyC', keyCode: 67, which: 67, bubbles: true }));
      `,
    });
    await sleep(2000);

    const recheck = await Runtime.evaluate({
      expression: `Object.keys(window.ViewState?._composeFormController || {})`,
      returnByValue: true,
    });
    console.log(`   Compose keys after retry: ${JSON.stringify(recheck.result.value)}`);

    if (recheck.result.value.length === 0) {
      console.log("   FAILED: Cannot open compose. Try manually pressing 'c' in Superhuman.");
      await client.close();
      process.exit(1);
    }
  }

  // Step 6: Type recipient
  console.log("5. Typing recipient...");
  const recipient = "ehu@law.virginia.edu";
  for (const ch of recipient) {
    await Input.dispatchKeyEvent({ type: "char", text: ch, key: ch });
    await sleep(20);
  }
  await sleep(500);

  // Press Tab to confirm recipient and move to next field
  await Input.dispatchKeyEvent({ type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Tab", code: "Tab" });
  await sleep(500);

  // Tab past CC
  await Input.dispatchKeyEvent({ type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Tab", code: "Tab" });
  await sleep(300);

  // Step 7: Type subject
  console.log("6. Typing subject...");
  const subject = `CDP send test ${new Date().toISOString().substring(11, 19)}`;
  for (const ch of subject) {
    await Input.dispatchKeyEvent({ type: "char", text: ch, key: ch });
    await sleep(20);
  }
  await sleep(300);

  // Tab to body
  await Input.dispatchKeyEvent({ type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Tab", code: "Tab" });
  await sleep(300);

  // Step 8: Type body
  console.log("7. Typing body...");
  const body = "Test email via CDP browser control.";
  for (const ch of body) {
    await Input.dispatchKeyEvent({ type: "char", text: ch, key: ch });
    await sleep(20);
  }
  await sleep(1000);

  // Step 9: Check draft state before send
  console.log("8. Checking draft state...");
  const draftState = await Runtime.evaluate({
    expression: `
      (() => {
        const cfc = window.ViewState?._composeFormController;
        const keys = Object.keys(cfc || {});
        const draftKey = keys.find(k => k.startsWith('draft'));
        if (!draftKey) return { error: "No draft" };
        const ctrl = cfc[draftKey];
        const draft = ctrl?.state?.draft;
        if (!draft) return { error: "No draft state" };

        const ga = window.GoogleAccount;
        const msg = draft.asMessage(ga?.di);
        const jsonReq = msg?.toJsonRequest?.();

        return {
          draftId: draft.attributes?.id || draftKey,
          to: draft.attributes?.to || draft.get?.('to'),
          subject: draft.attributes?.subject || draft.get?.('subject'),
          toJsonRequest: jsonReq,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(draftState.result.value, null, 2));

  // Step 10: Send with Cmd+Enter
  console.log("\n9. SENDING with Cmd+Enter...");
  await Input.dispatchKeyEvent({
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: 4, // Meta (Cmd)
  });
  await sleep(50);
  await Input.dispatchKeyEvent({
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: 4,
  });

  // Wait for all network traffic
  console.log("10. Waiting for network...");
  await sleep(8000);

  // Step 11: Display all captured traffic
  console.log("\n" + "=".repeat(60));
  console.log("CAPTURED NETWORK TRAFFIC");
  console.log("=".repeat(60));

  for (const req of capturedRequests) {
    console.log(`\n[${req.source || "page"}] ${req.method} ${req.url}`);
    console.log("Headers:", JSON.stringify(req.headers, null, 2));
    if (req.postData) {
      console.log("Body:");
      try {
        console.log(JSON.stringify(JSON.parse(req.postData), null, 2).substring(0, 5000));
      } catch {
        console.log(req.postData.substring(0, 2000));
      }
    }
  }

  console.log("\nResponses:");
  for (const resp of capturedResponses) {
    console.log(`  [${resp.source || "page"}] ${resp.status} ${resp.url}`);
    console.log(`  Body: ${resp.body.substring(0, 500)}`);
  }

  if (swClient) await swClient.close();
  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
