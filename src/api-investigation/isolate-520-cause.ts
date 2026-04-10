#!/usr/bin/env bun
/**
 * Isolate the exact cause of the 520 error from messages/send.
 *
 * Strategy: vary individual payload fields and see which combination
 * triggers 520 vs a different (more informative) error.
 *
 * Also: examine the HTTP utility (Ae.a.backend / fetcher) to understand
 * if it adds anything we're missing.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Isolate 520 Cause");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime } = client;

  // 1. Get auth info
  const auth = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const cred = ga?.backend?._credential || ga?.credential;
        return {
          idToken: await cred?.getIDTokenAsync?.(),
          email: ga.emailAddress,
          userId: cred?.user?._id,
          externalId: cred?.getExternalId?.(),
        };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  const a = auth.result.value;

  // 2. Get the HTTP utility (fetcher) source code
  console.log("\n1. HTTP Fetcher source");
  console.log("-".repeat(40));

  const fetcherSrc = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;

        // The fetch method calls Ae.a.backend(r, opts)
        // We need to find Ae.a - it's the HTTP fetcher module
        // Let's trace through the actual fetch call

        // backend.fetch calls:
        //   Ae.a.backend(r, opts)
        // where opts includes idToken, externalUserId, email, etc.

        // Ae.a is likely a FetchWrapper or similar
        // Let's look at the prototype chain for the class used

        // The error stack shows:
        //   fetcher_FetchWrapper.execute
        //   _._superhuman
        // So the fetcher has an execute method and _superhuman method

        // Let's find FetchWrapper by looking at the error constructor
        try {
          // Trigger an error and examine the stack
          // Actually, let's look for the module directly

          // Try to get the fetcher from the module webpack cache
          const webpackModules = typeof __webpack_modules__ !== 'undefined' ? Object.keys(__webpack_modules__) : [];

          // Look for the fetcher via the backend's constructor scope
          const src = backend.fetch.toString();

          // The line: Ae.a.backend(r,_)
          // Ae is a variable in the closure. We can't access it directly.
          // But we CAN look at what _superhuman and execute do

          // From the error stack: fetcher_FetchWrapper.execute
          // This suggests there's a FetchWrapper class

          return {
            backendFetchSrc: src,
            note: "Need to find FetchWrapper.execute and _._superhuman methods",
          };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(fetcherSrc.result.value, null, 2));

  // 3. Test various payload configurations
  console.log("\n2. Testing payload variations");
  console.log("-".repeat(40));

  async function testSend(label: string, body: any): Promise<{ label: string; status: number; response: string }> {
    const resp = await fetch("https://mail.superhuman.com/~backend/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Bearer ${a.idToken}`,
        "Cache-Control": "no-store",
        "x-superhuman-session-id": crypto.randomUUID(),
        "x-superhuman-request-id": crypto.randomUUID(),
        "x-superhuman-user-email": a.email,
        "x-superhuman-user-external-id": a.externalId,
        "x-superhuman-version": "2026-04-03T19:06:01Z",
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    return { label, status: resp.status, response: text.substring(0, 200) };
  }

  const draftId = `draft00${Array.from({ length: 14 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
  const shId = crypto.randomUUID();
  const rfc822 = `<${Math.random().toString(36).substring(2, 10)}.${crypto.randomUUID()}@we.are.superhuman.com>`;

  // Test A: Empty body
  const testA = await testSend("Empty body", {});
  console.log(`  ${testA.label}: ${testA.status} → ${testA.response}`);

  // Test B: Only version
  const testB = await testSend("Only version", { version: 3 });
  console.log(`  ${testB.label}: ${testB.status} → ${testB.response}`);

  // Test C: Minimal valid-looking payload
  const testC = await testSend("Minimal payload", {
    version: 3,
    outgoing_message: {
      from: a.email,
      to: ["ehu@law.virginia.edu"],
      subject: "test",
      html_body: "<div>test</div>",
    },
    delay: 0,
    is_multi_recipient: true,
  });
  console.log(`  ${testC.label}: ${testC.status} → ${testC.response}`);

  // Test D: With all standard fields
  const testD = await testSend("Full standard payload", {
    version: 3,
    outgoing_message: {
      headers: [
        { name: "X-Mailer", value: "Superhuman Web (2026-04-03T19:06:01Z)" },
        { name: "X-Superhuman-ID", value: shId },
        { name: "X-Superhuman-Draft-ID", value: draftId },
        { name: "X-Superhuman-Thread-ID", value: draftId },
      ],
      superhuman_id: shId,
      rfc822_id: rfc822,
      thread_id: draftId,
      message_id: draftId,
      in_reply_to: null,
      from: `eddyhu <${a.email}>`,
      to: ["ehu@law.virginia.edu"],
      cc: [],
      bcc: [],
      subject: "Test full payload",
      html_body: "<div>Test full payload</div>",
      attachments: [],
      scheduled_for: null,
      abort_on_reply: false,
      current_message_ids: [draftId],
      mail_merge_recipients: [],
    },
    delay: 0,
    is_multi_recipient: true,
  });
  console.log(`  ${testD.label}: ${testD.status} → ${testD.response}`);

  // Test E: Invalid version
  const testE = await testSend("Version 1", {
    version: 1,
    outgoing_message: {
      from: a.email,
      to: ["ehu@law.virginia.edu"],
      subject: "test v1",
      html_body: "<div>test</div>",
    },
    delay: 0,
  });
  console.log(`  ${testE.label}: ${testE.status} → ${testE.response}`);

  // Test F: Wrong content-type (text/plain like writeMessage uses)
  const respF = await fetch("https://mail.superhuman.com/~backend/messages/send", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "Authorization": `Bearer ${a.idToken}`,
      "x-superhuman-session-id": crypto.randomUUID(),
      "x-superhuman-request-id": crypto.randomUUID(),
      "x-superhuman-user-email": a.email,
      "x-superhuman-user-external-id": a.externalId,
      "x-superhuman-version": "2026-04-03T19:06:01Z",
    },
    body: JSON.stringify({
      version: 3,
      outgoing_message: {
        headers: [],
        superhuman_id: crypto.randomUUID(),
        rfc822_id: rfc822,
        thread_id: draftId,
        message_id: draftId,
        from: a.email,
        to: ["ehu@law.virginia.edu"],
        subject: "test text/plain",
        html_body: "<div>test</div>",
        attachments: [],
        current_message_ids: [draftId],
      },
      delay: 0,
      is_multi_recipient: true,
    }),
  });
  console.log(`  text/plain content-type: ${respF.status} → ${(await respF.text()).substring(0, 200)}`);

  // Test G: No Authorization header at all
  const respG = await fetch("https://mail.superhuman.com/~backend/messages/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ version: 3 }),
  });
  console.log(`  No auth: ${respG.status} → ${(await respG.text()).substring(0, 200)}`);

  // Test H: GET instead of POST
  const respH = await fetch("https://mail.superhuman.com/~backend/messages/send", {
    headers: { "Authorization": `Bearer ${a.idToken}` },
  });
  console.log(`  GET: ${respH.status} → ${(await respH.text()).substring(0, 200)}`);

  // 4. Check if the endpoint is actually /~backend/v3/messages.send (v3 pattern)
  console.log("\n\n3. Testing alternative endpoint paths");
  console.log("-".repeat(40));

  const altPaths = [
    "/~backend/v3/messages.send",
    "/~backend/v3/messages/send",
    "/~backend/v3/outgoing_message.send",
    "/~backend/messages.send",
  ];

  for (const path of altPaths) {
    const resp = await fetch(`https://mail.superhuman.com${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Bearer ${a.idToken}`,
        "x-superhuman-session-id": crypto.randomUUID(),
        "x-superhuman-request-id": crypto.randomUUID(),
        "x-superhuman-user-email": a.email,
        "x-superhuman-user-external-id": a.externalId,
      },
      body: JSON.stringify({
        version: 3,
        outgoing_message: {
          from: a.email,
          to: ["ehu@law.virginia.edu"],
          subject: "test",
          html_body: "<div>test</div>",
        },
        delay: 0,
        is_multi_recipient: true,
      }),
    });
    console.log(`  ${path}: ${resp.status} → ${(await resp.text()).substring(0, 200)}`);
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
