#!/usr/bin/env bun
/**
 * Test: create a real draft and then attempt to send it from the browser
 * to see if the 520 is a "draft not found" issue or something else.
 */
import CDP from "chrome-remote-interface";
import { getUserInfo, createDraftWithUserInfo } from "../src/draft-api.ts";

const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const bgPage = targets.find((t: any) => t.url.includes("background_page"));
  
  if (!bgPage) {
    console.error("Background page not found");
    process.exit(1);
  }
  
  const conn = await CDP({ target: bgPage.id, port: CDP_PORT });
  
  console.log("Getting user info...");
  const userInfo = await getUserInfo(conn);
  console.log("User:", userInfo.email, "userId:", userInfo.userId);
  
  // Create a real draft
  console.log("\nCreating draft...");
  const draft = await createDraftWithUserInfo(conn, userInfo, {
    to: [{ email: "ehu@law.virginia.edu", name: "Test" }],
    subject: "CLI Send Test " + Date.now(),
    htmlBody: "<p>Test email from CLI</p>",
    text: "Test email from CLI",
  });
  
  if (!draft.success) {
    console.error("Draft creation failed:", draft.error);
    process.exit(1);
  }
  
  console.log("Draft created:", { draftId: draft.draftId, threadId: draft.threadId });
  
  // Now try sending from browser context using backend.fetch with the REAL draft IDs
  await conn.close();
  
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  const client = await CDP({ target: mainPage.id, port: CDP_PORT });
  const { Runtime } = client;
  
  const draftId = draft.draftId!;
  const threadId = draft.threadId!;
  const email = userInfo.email;
  const displayName = userInfo.displayName || email;
  const superhumanId = crypto.randomUUID();
  const rfc822Id = `<${Math.random().toString(36).slice(2)}.${crypto.randomUUID()}@we.are.superhuman.com>`;
  
  const result = await Runtime.evaluate({
    expression: `(async () => {
      try {
        const ga = window.GoogleAccount;
        const backend = ga.backend;
        const superhumanId = '${superhumanId}';
        const draftId = '${draftId}';
        const threadId = '${threadId}';
        
        const body = {
          version: 3,
          outgoing_message: {
            headers: [
              {name: 'X-Mailer', value: 'Superhuman Web (2026-04-03T19:06:01Z)'},
              {name: 'X-Superhuman-ID', value: superhumanId},
              {name: 'X-Superhuman-Draft-ID', value: draftId},
              {name: 'X-Superhuman-Thread-ID', value: threadId},
            ],
            superhuman_id: superhumanId,
            rfc822_id: '${rfc822Id}',
            thread_id: threadId,
            message_id: draftId,
            in_reply_to: null,
            from: '${displayName} <${email}>',
            to: ['ehu@law.virginia.edu'],
            cc: [], bcc: [],
            subject: 'CLI Send Test (browser test)',
            html_body: '<p>Test email from CLI via browser context</p>',
            attachments: [],
            scheduled_for: null,
            abort_on_reply: false,
            current_message_ids: [draftId],
            mail_merge_recipients: [],
          },
          delay: 20,
          is_multi_recipient: true,
        };
        
        console.log('Sending with draftId:', draftId, 'threadId:', threadId);
        
        const resp = await backend.fetch('/~backend/messages/send', {
          endpoint: 'messages.send',
          method: 'POST',
          headers: {'Content-Type': 'application/json; charset=utf-8'},
          body: JSON.stringify(body)
        });
        return {ok: true, value: JSON.stringify(resp).substring(0, 300)};
      } catch(e) {
        return {error: e.message, code: e.status || e.code};
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 15000,
  });
  
  console.log("\nSend result from browser:", JSON.stringify(result.result.value, null, 2));
  await client.close();
}

main().catch(console.error);
