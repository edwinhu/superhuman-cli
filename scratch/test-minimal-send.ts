#!/usr/bin/env bun
import CDP from "chrome-remote-interface";
const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  const client = await CDP({ target: mainPage.id, port: CDP_PORT });
  const { Runtime } = client;
  
  const result = await Runtime.evaluate({
    expression: `(async () => {
      const backend = window.GoogleAccount.backend;
      const tests = [
        // Garbage body
        {label: 'garbage', body: {foo: 'bar'}},
        // Empty body
        {label: 'empty', body: {}},
        // Missing outgoing_message
        {label: 'no_outgoing', body: {version: 3, delay: 20, is_multi_recipient: true}},
        // Wrong version
        {label: 'version_1', body: {version: 1, outgoing_message: {thread_id: 'draft00test', message_id: 'draft00test', from: 'test@test.com', to: ['t@t.com'], subject: 'test', html_body: 'test'}, delay: 20, is_multi_recipient: true}},
        // Version 3 with minimal but valid-looking outgoing_message
        {label: 'minimal_v3', body: {version: 3, outgoing_message: {thread_id: 'draft00test', message_id: 'draft00test', from: 'test@test.com', to: ['t@t.com'], subject: 'test', html_body: 'test', superhuman_id: crypto.randomUUID(), rfc822_id: '<t@t.com>', headers: [], attachments: [], in_reply_to: null, cc: [], bcc: [], scheduled_for: null, abort_on_reply: false, current_message_ids: ['draft00test'], mail_merge_recipients: []}, delay: 20, is_multi_recipient: true}},
      ];
      
      const results = [];
      for (const test of tests) {
        try {
          const resp = await backend.fetch('/~backend/messages/send', {
            endpoint: 'messages.send', method: 'POST',
            headers: {'Content-Type': 'application/json; charset=utf-8'},
            body: JSON.stringify(test.body)
          });
          results.push({label: test.label, status: 'ok', result: JSON.stringify(resp).substring(0,100)});
        } catch(e) {
          results.push({label: test.label, error: e.message.substring(0,100)});
        }
      }
      return results;
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000,
  });
  
  console.log(JSON.stringify(result.result.value, null, 2));
  await client.close();
}

main().catch(console.error);
