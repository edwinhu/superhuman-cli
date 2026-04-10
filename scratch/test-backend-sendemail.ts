#!/usr/bin/env bun
import CDP from "chrome-remote-interface";
const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  const client = await CDP({ target: mainPage.id, port: CDP_PORT });
  const { Runtime, Network } = client;
  
  await Network.enable({ maxPostDataSize: 100000 });
  
  Network.requestWillBeSent((params: any) => {
    if (params.request.url.includes("messages/send")) {
      console.log("\n=== REQUEST ===", params.request.url);
      console.log("Headers:", JSON.stringify(params.request.headers));
      if (params.request.postData) {
        const body = JSON.parse(params.request.postData);
        console.log("Body:", JSON.stringify(body, null, 2).substring(0, 2000));
      }
    }
  });
  
  Network.responseReceived(async (params: any) => {
    if (params.response.url.includes("messages/send")) {
      console.log("\n=== RESPONSE ===", params.response.status);
      try {
        const body = await Network.getResponseBody({ requestId: params.requestId });
        console.log("Body:", body.body);
      } catch {}
    }
  });
  
  // Call backend.sendEmail with a duck-typed OutgoingMessage
  const result = await Runtime.evaluate({
    expression: `(async () => {
      try {
        const ga = window.GoogleAccount;
        const backend = ga.backend;
        const email = ga.emailAddress;
        
        // Generate IDs
        const draftId = 'draft00' + Array.from({length:14}, () => Math.floor(Math.random()*16).toString(16)).join('');
        const superhumanId = crypto.randomUUID();
        const rfc822Id = '<t.' + crypto.randomUUID() + '@we.are.superhuman.com>';
        const now = new Date().toISOString();
        
        // Create a duck-typed OutgoingMessage
        const outgoingMessage = {
          toJsonRequest() {
            return {
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
              from: email,
              to: ['ehu@law.virginia.edu'],
              cc: [], bcc: [],
              subject: 'CLI Browser sendEmail test ' + Date.now(),
              html_body: '<p>Test via backend.sendEmail</p>',
              attachments: [],
              scheduled_for: null,
              abort_on_reply: false,
              current_message_ids: [draftId],
              mail_merge_recipients: [],
            };
          },
          getMessageId() { return draftId; },
          getThreadId() { return draftId; },
          getSubject() { return 'CLI Browser sendEmail test'; },
        };
        
        // Call the actual sendEmail
        const result = await backend.sendEmail(outgoingMessage, null);
        return {ok: true, result: JSON.stringify(result).substring(0, 300)};
      } catch(e) {
        return {error: e.message, status: e.status, code: e.code};
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 20000,
  });
  
  console.log("sendEmail result:", JSON.stringify(result.result.value, null, 2));
  
  await new Promise(r => setTimeout(r, 2000));
  await client.close();
}

main().catch(console.error);
