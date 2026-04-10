#!/usr/bin/env bun
/**
 * Create a real draft, then try to send it from both:
 * 1. Direct CLI fetch (to see what fails)  
 * 2. browser backend.fetch (to see what headers it adds via Network monitoring)
 */
import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  
  const bgWorker = targets.find((t: any) => 
    t.url.includes("background_page") && t.type === "service_worker"
  );
  const mainPage = targets.find((t: any) => 
    t.url.includes("mail.superhuman.com") && t.type === "page"
  );
  
  if (!bgWorker || !mainPage) {
    console.error("Required targets not found");
    console.log("Available:", targets.map((t: any) => `${t.type}: ${t.url}`).join("\n"));
    process.exit(1);
  }
  
  console.log("Background worker:", bgWorker.url);
  console.log("Main page:", mainPage.url);
  
  // Connect to main page for Network monitoring AND Runtime
  const client = await CDP({ target: mainPage.id, port: CDP_PORT });
  const { Network, Runtime } = client;
  
  await Network.enable({ maxPostDataSize: 100000 });
  
  // Capture requests to messages/send
  const captured: any[] = [];
  Network.requestWillBeSent((params: any) => {
    if (params.request.url.includes("messages/send")) {
      captured.push({
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers,
        postData: params.request.postData?.substring(0, 500),
        requestId: params.requestId,
      });
      console.log("\n=== REQUEST CAPTURED ===");
      console.log("URL:", params.request.url);
      console.log("Headers:", JSON.stringify(params.request.headers, null, 2));
    }
  });
  
  Network.responseReceived(async (params: any) => {
    if (params.response.url.includes("messages/send")) {
      console.log("\n=== RESPONSE ===");
      console.log("Status:", params.response.status);
      try {
        const body = await Network.getResponseBody({ requestId: params.requestId });
        console.log("Body:", body.body?.substring(0, 500));
      } catch {}
    }
  });
  
  // Now use Runtime.evaluate to call backend.fetch from the page
  // First, get the token by calling from the service worker context
  const swClient = await CDP({ target: bgWorker.id, port: CDP_PORT });
  const { Runtime: swRuntime } = swClient;
  
  // Get token from service worker
  const tokenResult = await swRuntime.evaluate({
    expression: `(async () => {
      try {
        const keys = Object.keys(globalThis);
        // Try to find token in various ways
        if (typeof backgrounds !== 'undefined') {
          const entries = Object.values(backgrounds);
          for (const bg of entries) {
            const ab = bg._accountBackground || bg;
            if (ab._authData && ab._authData.idToken) {
              return {
                token: ab._authData.idToken,
                email: ab._authData.emailAddress,
                externalId: ab._authData.externalId,
                deviceId: ab._authData.deviceId,
              };
            }
          }
        }
        return {keys: keys.slice(0, 30)};
      } catch(e) {
        return {error: e.message};
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  
  console.log("SW token result:", JSON.stringify(tokenResult.result.value, null, 2));
  
  // Now call backend.fetch from main page
  console.log("\nCalling backend.fetch from main page...");
  const sendResult = await Runtime.evaluate({
    expression: `(async () => {
      try {
        const ga = window.GoogleAccount;
        const backend = ga.backend;
        
        // Get the draft IDs from a newly created temp draft
        const draftId = 'draft00' + Array.from({length: 14}, () => Math.floor(Math.random()*16).toString(16)).join('');
        const superhumanId = crypto.randomUUID();
        const rfc822Id = '<t.' + crypto.randomUUID() + '@we.are.superhuman.com>';
        
        console.log('Using draftId:', draftId);
        
        const body = {
          version: 3,
          outgoing_message: {
            headers: [
              {name: 'X-Mailer', value: 'Superhuman Web (2026-04-03T19:06:01Z)'},
              {name: 'X-Superhuman-ID', value: superhumanId},
              {name: 'X-Superhuman-Draft-ID', value: draftId},
              {name: 'X-Superhuman-Thread-ID', value: draftId},
            ],
            superhuman_id: superhumanId,
            rfc822_id: rfc822Id,
            thread_id: draftId,
            message_id: draftId,
            in_reply_to: null,
            from: 'Eddy Hu <eddyhu@gmail.com>',
            to: ['ehu@law.virginia.edu'],
            cc: [], bcc: [],
            subject: 'CLI Test via browser',
            html_body: '<p>Test from browser backend.fetch</p>',
            attachments: [],
            scheduled_for: null,
            abort_on_reply: false,
            current_message_ids: [draftId],
            mail_merge_recipients: [],
          },
          delay: 20,
          is_multi_recipient: true,
        };
        
        const resp = await backend.fetch('/~backend/messages/send', {
          endpoint: 'messages.send',
          method: 'POST',
          headers: {'Content-Type': 'application/json; charset=utf-8'},
          body: JSON.stringify(body)
        });
        return {ok: true, result: JSON.stringify(resp).substring(0, 300)};
      } catch(e) {
        return {error: e.message, status: e.status};
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 15000,
  });
  
  console.log("\nSend result:", JSON.stringify(sendResult.result.value, null, 2));
  
  // Wait a bit for network events
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log("\nCaptured requests:", captured.length);
  
  await swClient.close();
  await client.close();
}

main().catch(console.error);
