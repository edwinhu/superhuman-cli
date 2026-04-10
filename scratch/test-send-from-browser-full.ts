#!/usr/bin/env bun
/**
 * Full end-to-end test from browser context:
 * 1. Write draft to Firebase via userdata.writeMessage (same as CLI)
 * 2. Call messages/send via backend.fetch with that draft ID
 * If this works but CLI fails, the issue is CLI context.
 * If this also fails, the issue is in the send body/server.
 */
import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  const client = await CDP({ target: mainPage.id, port: CDP_PORT });
  const { Runtime } = client;

  const result = await Runtime.evaluate({
    expression: `(async () => {
      try {
        const ga = window.GoogleAccount;
        const backend = ga.backend;
        const cred = ga.credential;
        const authData = cred._authData;
        const userId = cred.user._id;
        const email = ga.emailAddress;
        
        // Generate draft IDs
        const hex = () => Array.from({length:14}, () => Math.floor(Math.random()*16).toString(16)).join('');
        const draftId = 'draft00' + hex();
        const threadId = draftId; // new thread = same as draftId
        const superhumanId = crypto.randomUUID();
        const rfc822Id = '<t.' + crypto.randomUUID() + '@we.are.superhuman.com>';
        const now = new Date().toISOString();
        
        console.log('Creating draft:', draftId, 'userId:', userId);
        
        // Step 1: Write draft to Firebase (same as CLI's createDraftWithUserInfo)
        const draftValue = {
          id: draftId,
          threadId: threadId,
          action: 'compose',
          name: null,
          from: email,
          to: ['ehu@law.virginia.edu'],
          cc: [],
          bcc: [],
          subject: 'CLI Browser Test ' + Date.now(),
          body: '<p>Test from browser CDP</p>',
          snippet: 'Test from browser CDP',
          inReplyToRfc822Id: null,
          labelIds: ['DRAFT'],
          clientCreatedAt: now,
          date: now,
          fingerprint: {to: 'ehu@law.virginia.edu', cc: '', attachments: ''},
          lastSessionId: crypto.randomUUID(),
          quotedContent: '',
          quotedContentInlined: false,
          references: [],
          reminder: null,
          rfc822Id: rfc822Id,
          scheduledFor: null,
          scheduledReplyInterruptedAt: null,
          schemaVersion: 3,
          totalComposeSeconds: 0,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
        
        const writeResp = await backend.fetch('/~backend/v3/userdata.writeMessage', {
          endpoint: 'userdata.writeMessage',
          method: 'POST',
          headers: {'Content-Type': 'text/plain;charset=UTF-8'},
          body: JSON.stringify({
            writes: [{
              path: 'users/' + userId + '/threads/' + threadId + '/messages/' + draftId + '/draft',
              value: draftValue,
            }]
          })
        });
        console.log('Draft write result:', JSON.stringify(writeResp).substring(0,100));
        
        // Small delay to ensure Firebase write propagates
        await new Promise(r => setTimeout(r, 500));
        
        // Step 2: logSend with draft_ready
        const outgoingMsg = {
          headers: [
            {name: 'X-Mailer', value: 'Superhuman Web (2026-04-03T19:06:01Z)'},
            {name: 'X-Superhuman-ID', value: superhumanId},
            {name: 'X-Superhuman-Draft-ID', value: draftId},
            {name: 'X-Superhuman-Thread-ID', value: draftId},
          ],
          superhuman_id: superhumanId,
          rfc822_id: rfc822Id,
          thread_id: threadId,
          message_id: draftId,
          in_reply_to: null,
          from: email,
          to: ['ehu@law.virginia.edu'],
          cc: [], bcc: [],
          subject: 'CLI Browser Test ' + Date.now(),
          html_body: '<p>Test from browser CDP</p>',
          attachments: [],
          scheduled_for: null,
          abort_on_reply: false,
          current_message_ids: [draftId],
          mail_merge_recipients: [],
        };
        
        const logResp = await backend.fetch('/~backend/messages/send/log', {
          endpoint: 'messages.send.log',
          method: 'POST',
          headers: {'Content-Type': 'application/json; charset=utf-8'},
          body: JSON.stringify({
            action: 'draft_ready',
            draft: outgoingMsg,
            superhuman_id: superhumanId,
            draft_message_id: draftId,
            draft_thread_id: threadId,
            client_sent_at: new Date().toISOString(),
          })
        }).catch(e => ({error: e.message}));
        console.log('logSend result:', JSON.stringify(logResp).substring(0,100));
        
        // Step 3: Send
        const sendResp = await backend.fetch('/~backend/messages/send', {
          endpoint: 'messages.send',
          method: 'POST',
          headers: {'Content-Type': 'application/json; charset=utf-8'},
          body: JSON.stringify({
            version: 3,
            outgoing_message: outgoingMsg,
            delay: 20,
            is_multi_recipient: true,
          })
        }).catch(e => ({error: e.message, status: e.status}));
        
        return {
          draftId, threadId,
          sendResult: sendResp,
        };
      } catch(e) {
        return {error: e.message, stack: e.stack && e.stack.substring(0,300)};
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000,
  });
  
  console.log(JSON.stringify(result.result.value, null, 2));
  await client.close();
}

main().catch(console.error);
