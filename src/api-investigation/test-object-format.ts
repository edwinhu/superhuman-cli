#!/usr/bin/env bun
/**
 * Test messages/send with object format for from/to (matching browser behavior)
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Test Object Format for messages/send");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime } = client;

  // Get auth for Gmail account
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
          displayName: cred?.user?.displayName || ga?.displayName || null,
          deviceId: window.device?.id || null,
        };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  const a = auth.result.value;
  console.log(`Account: ${a.email}`);
  console.log(`Display name: ${a.displayName}`);

  // Generate IDs
  const draftId = `draft00${Array.from({ length: 14 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
  const threadId = `draft00${Array.from({ length: 14 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
  const shortPrefix = Math.random().toString(36).substring(2, 10);
  const superhumanId = `${shortPrefix}.${crypto.randomUUID()}`;
  const rfc822Id = `<${shortPrefix}.${crypto.randomUUID()}@we.are.superhuman.com>`;

  const fromName = a.displayName || a.email.split("@")[0];

  // First write the draft to Firebase
  console.log("\n1. Writing draft to Firebase...");
  const now = new Date().toISOString();
  const draftWrite = {
    writes: [{
      path: `users/${a.userId}/threads/${threadId}/messages/${draftId}/draft`,
      value: {
        id: draftId,
        threadId: threadId,
        action: "compose",
        name: null,
        from: `${fromName} <${a.email}>`,
        to: ["ehu@law.virginia.edu"],
        cc: [],
        bcc: [],
        subject: `Object format test ${now.substring(11, 19)}`,
        body: "<div>Test with object format for from/to</div>",
        snippet: "Test with object format",
        inReplyToRfc822Id: null,
        labelIds: ["DRAFT"],
        clientCreatedAt: now,
        date: now,
        fingerprint: { to: "ehu@law.virginia.edu", cc: "", attachments: "" },
        lastSessionId: crypto.randomUUID(),
        quotedContent: "",
        quotedContentInlined: false,
        references: [],
        reminder: null,
        rfc822Id: rfc822Id,
        scheduledFor: null,
        scheduledReplyInterruptedAt: null,
        schemaVersion: 3,
        totalComposeSeconds: 0,
        timeZone: "America/New_York",
      },
    }],
  };

  const writeResp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.writeMessage", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      Authorization: `Bearer ${a.idToken}`,
    },
    body: JSON.stringify(draftWrite),
  });
  console.log(`Draft write: ${writeResp.status} ${await writeResp.text()}`);

  // Now send with OBJECT format (matching browser)
  console.log("\n2. Sending with object format...");
  const outgoingMessage = {
    headers: [
      { name: "X-Mailer", value: "Superhuman Web (2026-04-03T19:06:01Z)" },
      { name: "X-Superhuman-ID", value: superhumanId },
      { name: "X-Superhuman-Draft-ID", value: draftId },
      { name: "X-Superhuman-Thread-ID", value: threadId },
    ],
    superhuman_id: superhumanId,
    rfc822_id: rfc822Id,
    thread_id: threadId,
    message_id: draftId,
    in_reply_to: null,
    // CRITICAL: Use object format, not string
    from: { email: a.email, name: fromName },
    to: [{ email: "ehu@law.virginia.edu", name: "Edwin Hu" }],
    cc: [],
    bcc: [],
    subject: `Object format test ${now.substring(11, 19)}`,
    html_body: "<div>Test with object format for from/to</div>",
    attachments: [],
    scheduled_for: null,
    abort_on_reply: false,
    current_message_ids: [draftId],
    mail_merge_recipients: [],
  };

  const requestBody = {
    version: 3,
    outgoing_message: outgoingMessage,
    delay: 0, // Immediate for testing
    is_multi_recipient: true,
  };

  const shHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Authorization": `Bearer ${a.idToken}`,
    "Cache-Control": "no-store",
    "x-superhuman-session-id": `background-${crypto.randomUUID()}`,
    "x-superhuman-request-id": crypto.randomUUID(),
    "x-superhuman-user-email": a.email,
    "x-superhuman-user-external-id": a.externalId,
    "x-superhuman-version": "2026-04-03T19:06:01Z",
  };

  const resp = await fetch("https://mail.superhuman.com/~backend/messages/send", {
    method: "POST",
    headers: shHeaders,
    body: JSON.stringify(requestBody),
  });

  const text = await resp.text();
  console.log(`Status: ${resp.status}`);
  console.log(`Body: ${text}`);

  if (resp.status === 200) {
    console.log("\n✅ SUCCESS! Object format works!");
  } else {
    console.log("\n❌ Still failing. Trying without draft write...");

    // Test without writing draft first
    const draftId2 = `draft00${Array.from({ length: 14 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
    const threadId2 = `draft00${Array.from({ length: 14 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
    const shId2 = `${Math.random().toString(36).substring(2, 10)}.${crypto.randomUUID()}`;
    const rfc2 = `<${Math.random().toString(36).substring(2, 10)}.${crypto.randomUUID()}@we.are.superhuman.com>`;

    const resp2 = await fetch("https://mail.superhuman.com/~backend/messages/send", {
      method: "POST",
      headers: { ...shHeaders, "x-superhuman-request-id": crypto.randomUUID() },
      body: JSON.stringify({
        version: 3,
        outgoing_message: {
          headers: [
            { name: "X-Mailer", value: "Superhuman Web (2026-04-03T19:06:01Z)" },
            { name: "X-Superhuman-ID", value: shId2 },
            { name: "X-Superhuman-Draft-ID", value: draftId2 },
            { name: "X-Superhuman-Thread-ID", value: threadId2 },
          ],
          superhuman_id: shId2,
          rfc822_id: rfc2,
          thread_id: threadId2,
          message_id: draftId2,
          in_reply_to: null,
          from: { email: a.email, name: fromName },
          to: [{ email: "ehu@law.virginia.edu" }],
          cc: [],
          bcc: [],
          subject: `No draft write test ${new Date().toISOString().substring(11, 19)}`,
          html_body: "<div>Test without pre-writing draft</div>",
          attachments: [],
          scheduled_for: null,
          abort_on_reply: false,
          current_message_ids: [draftId2],
          mail_merge_recipients: [],
        },
        delay: 0,
        is_multi_recipient: true,
      }),
    });

    console.log(`No-draft-write test: ${resp2.status} ${await resp2.text()}`);
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
