#!/usr/bin/env bun
/**
 * Test send via browser's backend.sendEmail() by constructing
 * an OutgoingMessage from scratch in the browser context.
 *
 * This will tell us:
 * - If backend.sendEmail() works from browser context → issue is CLI-side
 * - If it also fails → issue is deeper (payload format, server-side)
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Test Browser Send (Programmatic)");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime, Network } = client;
  await Network.enable();

  // Set up network monitoring for the messages/send request
  const capturedRequests: any[] = [];
  Network.requestWillBeSent((params: any) => {
    if (params.request.url.includes("messages/send")) {
      capturedRequests.push({
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers,
        postData: params.request.postData?.substring(0, 3000),
      });
    }
  });

  const capturedResponses: any[] = [];
  Network.responseReceived(async (params: any) => {
    if (params.response.url.includes("messages/send") && !params.response.url.includes("/log")) {
      const body = await Network.getResponseBody({ requestId: params.requestId }).catch(() => ({ body: "unavailable" }));
      capturedResponses.push({
        url: params.response.url,
        status: params.response.status,
        body: body.body?.substring(0, 500),
      });
    }
  });

  // 1. First, let's understand the OutgoingMessage constructor
  console.log("\n1. Understanding OutgoingMessage class");
  console.log("-".repeat(40));

  const msgClass = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const di = ga?.di;

        // Try to find OutgoingMessage class from di or globals
        // The draft.asMessage(di) creates an OutgoingMessage
        // We need to find the class to construct one ourselves

        // Strategy: create a temporary compose form to get the class
        // Or: look through the DI container for the Message factory

        // Try to find it via di
        let outgoingMsgClass = null;
        let draftClass = null;

        try {
          // Look for factories or constructors in DI
          const diKeys = [];
          if (di && typeof di.has === 'function') {
            // Common DI keys
            for (const k of ['OutgoingMessage', 'outgoingMessage', 'DraftModel', 'Draft',
                           'MessageFactory', 'messageFactory', 'ComposeModel', 'composeModel']) {
              try {
                if (di.has(k)) diKeys.push({ key: k, type: typeof di.get(k) });
              } catch {}
            }
          }
          return { diKeys };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(msgClass.result.value, null, 2));

  // 2. Create a draft via API and then trigger send from browser context
  console.log("\n2. Creating draft via API, then sending from browser");
  console.log("-".repeat(40));

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const backend = ga?.backend;
          const cred = backend?._credential || ga?.credential;

          // Get user info
          const email = ga.emailAddress;
          const userId = cred?.user?._id;
          const idToken = await cred?.getIDTokenAsync?.();

          // 1. Create a draft ID
          const draftId = 'draft00' + Array.from({length: 14}, () =>
            Math.floor(Math.random() * 16).toString(16)).join('');
          const threadId = draftId; // New compose
          const rfc822Id = '<' + Math.random().toString(36).substring(2,10) + '.' +
            crypto.randomUUID() + '@we.are.superhuman.com>';
          const superhumanId = crypto.randomUUID();
          const now = new Date().toISOString();
          const subject = 'Browser send test ' + now.substring(11,19);

          // 2. Write draft to Firebase (same as CLI does)
          const draftValue = {
            id: draftId,
            threadId: threadId,
            action: 'compose',
            name: null,
            from: email,
            to: ['ehu@law.virginia.edu'],
            cc: [],
            bcc: [],
            subject: subject,
            body: '<div>Test from browser sendEmail() call</div>',
            snippet: 'Test from browser sendEmail() call',
            inReplyToRfc822Id: null,
            labelIds: ['DRAFT'],
            clientCreatedAt: now,
            date: now,
            fingerprint: { to: 'ehu@law.virginia.edu', cc: '', attachments: '' },
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
            timeZone: 'America/New_York',
          };

          // Write via backend.writeUserDataMessage (same method browser uses)
          const writes = [{
            path: 'threads/' + threadId + '/messages/' + draftId + '/draft',
            value: draftValue,
          }];

          const writeResult = await backend.writeUserDataMessage(writes);

          // 3. Now construct what toJsonRequest() would produce
          // and call backend.sendEmail() with it

          // We need an OutgoingMessage object with toJsonRequest()
          // Let's try to find the class via a compose form

          // Alternative: monkey-patch to capture what sendEmail expects
          // and construct a minimal object that satisfies it

          // Looking at sendEmail source:
          //   const y = {version:3, outgoing_message: r.toJsonRequest(), ...}
          //   It also calls r.getSubject(), r.getSuperhumanId(), r.getThreadId(), r.getMessageId()

          // So r needs: toJsonRequest(), getSubject(), getSuperhumanId(), getThreadId(), getMessageId()

          const outgoingMsg = {
            toJsonRequest() {
              return {
                headers: [
                  { name: 'X-Mailer', value: 'Superhuman Web (2026-04-03T19:06:01Z)' },
                  { name: 'X-Superhuman-ID', value: superhumanId },
                  { name: 'X-Superhuman-Draft-ID', value: draftId },
                  { name: 'X-Superhuman-Thread-ID', value: threadId },
                ],
                superhuman_id: superhumanId,
                rfc822_id: rfc822Id,
                thread_id: threadId,
                message_id: draftId,
                in_reply_to: null,
                from: email,
                to: ['ehu@law.virginia.edu'],
                cc: [],
                bcc: [],
                subject: subject,
                html_body: '<div>Test from browser sendEmail() call</div>',
                attachments: [],
                scheduled_for: null,
                abort_on_reply: false,
                current_message_ids: [draftId],
                mail_merge_recipients: [],
              };
            },
            getSubject() { return subject; },
            getSuperhumanId() { return superhumanId; },
            getThreadId() { return threadId; },
            getMessageId() { return draftId; },
          };

          // Call sendEmail
          const sendResult = await backend.sendEmail(outgoingMsg);

          return {
            success: true,
            writeResult,
            sendResult,
            draftId,
            threadId,
            subject,
          };
        } catch (e) {
          return {
            success: false,
            error: e.message,
            stack: e.stack?.substring(0, 500),
          };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(result.result.value, null, 2));

  // Wait for network captures
  await new Promise(r => setTimeout(r, 2000));

  // 3. Show captured network traffic
  console.log("\n\n3. Captured Network Traffic");
  console.log("-".repeat(40));

  console.log("Requests:");
  for (const req of capturedRequests) {
    console.log(`  ${req.method} ${req.url}`);
    if (req.postData) {
      try {
        const body = JSON.parse(req.postData);
        console.log("  Body:", JSON.stringify(body, null, 2).substring(0, 2000));
      } catch {
        console.log("  Body (raw):", req.postData.substring(0, 500));
      }
    }
  }

  console.log("\nResponses:");
  for (const resp of capturedResponses) {
    console.log(`  ${resp.status} ${resp.url}`);
    console.log(`  Body: ${resp.body}`);
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
