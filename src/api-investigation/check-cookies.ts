#!/usr/bin/env bun
/**
 * Extract cookies for mail.superhuman.com and test send with cookies
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Extract Superhuman Cookies");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Network, Storage } = client;
  await Network.enable();

  // 1. Get all cookies for mail.superhuman.com
  console.log("\n1. Cookies for mail.superhuman.com");
  console.log("-".repeat(40));

  const cookies = await Network.getCookies({ urls: ["https://mail.superhuman.com"] });
  for (const cookie of cookies.cookies) {
    const val = cookie.value.length > 80 ? cookie.value.substring(0, 80) + "..." : cookie.value;
    console.log(`  ${cookie.name} = ${val}`);
    console.log(`    domain: ${cookie.domain}, path: ${cookie.path}, httpOnly: ${cookie.httpOnly}, secure: ${cookie.secure}, sameSite: ${cookie.sameSite}`);
  }

  // 2. Build cookie string for CLI use
  const cookieStr = cookies.cookies
    .map((c: any) => `${c.name}=${c.value}`)
    .join("; ");
  console.log(`\nFull cookie string (${cookieStr.length} chars):`);
  console.log(cookieStr.substring(0, 200) + (cookieStr.length > 200 ? "..." : ""));

  // 3. Also check if CSRF token needs to be in a header
  console.log("\n\n2. CSRF token check");
  console.log("-".repeat(40));

  const csrfCheck = await client.Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const cred = ga?.backend?._credential || ga?.credential;

        // Get CSRF token
        let csrfToken = null;
        try { csrfToken = await cred?.getCsrfToken?.(); } catch (e) { csrfToken = "ERROR: " + e.message; }

        // Check _withCsrfTokenAsync source - this may be used for certain endpoints
        let withCsrfSrc = null;
        try { withCsrfSrc = cred?._withCsrfTokenAsync?.toString()?.substring(0, 1000); } catch {}

        return { csrfToken, withCsrfSrc };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(csrfCheck.result.value, null, 2));

  // 4. Now let's test: send a real email via CLI with cookies included
  // First, get the necessary info to construct a send request
  console.log("\n\n3. Test send with cookies");
  console.log("-".repeat(40));

  const authInfo = await client.Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const cred = ga?.backend?._credential || ga?.credential;
        const idToken = await cred?.getIDTokenAsync?.();
        const externalId = cred?.getExternalId?.();

        return {
          email: ga.emailAddress,
          idToken: idToken?.substring(0, 50) + "...",
          idTokenFull: idToken,
          externalId,
          deviceId: window.device?.id || ga?.device?.id,
          userId: cred?.user?._id,
        };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  const auth = authInfo.result.value;
  console.log("Auth info:", JSON.stringify({ ...auth, idTokenFull: auth.idTokenFull?.substring(0, 50) + "..." }, null, 2));

  // Build a minimal send payload for a test email
  const draftId = `draft00${Array.from({ length: 14 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
  const superhumanId = crypto.randomUUID();
  const rfc822Id = `<${Math.random().toString(36).substring(2, 10)}.${crypto.randomUUID()}@we.are.superhuman.com>`;

  const outgoingMessage = {
    headers: [
      { name: "X-Mailer", value: "Superhuman Web (2026-04-03T19:06:01Z)" },
      { name: "X-Superhuman-ID", value: superhumanId },
      { name: "X-Superhuman-Draft-ID", value: draftId },
      { name: "X-Superhuman-Thread-ID", value: draftId },
    ],
    superhuman_id: superhumanId,
    rfc822_id: rfc822Id,
    thread_id: draftId,
    message_id: draftId,
    in_reply_to: null,
    from: `eddyhu <${auth.email}>`,
    to: ["ehu@law.virginia.edu"],
    cc: [],
    bcc: [],
    subject: `Test send with cookies ${new Date().toISOString().substring(11, 19)}`,
    html_body: "<div>Test email sent from CLI with browser cookies to debug 520 error.</div>",
    attachments: [],
    scheduled_for: null,
    abort_on_reply: false,
    current_message_ids: [draftId],
    mail_merge_recipients: [],
  };

  const requestBody = {
    version: 3,
    outgoing_message: outgoingMessage,
    delay: 0, // Immediate send for testing
    is_multi_recipient: true,
  };

  // First, write the draft to Firebase (like our CLI does)
  console.log("\nWriting draft to Firebase...");
  const now = new Date().toISOString();
  const draftWrite = {
    writes: [{
      path: `users/${auth.userId}/threads/${draftId}/messages/${draftId}/draft`,
      value: {
        id: draftId,
        threadId: draftId,
        action: "compose",
        name: null,
        from: `eddyhu <${auth.email}>`,
        to: ["ehu@law.virginia.edu"],
        cc: [],
        bcc: [],
        subject: outgoingMessage.subject,
        body: outgoingMessage.html_body,
        snippet: "Test email sent from CLI with browser cookies",
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
      Authorization: `Bearer ${auth.idTokenFull}`,
    },
    body: JSON.stringify(draftWrite),
  });
  console.log("Draft write:", writeResp.status, await writeResp.text().catch(() => ""));

  // Now send WITHOUT cookies (like our CLI does)
  console.log("\nTest A: Send WITHOUT cookies (current CLI behavior)...");
  const headersNoCookie = {
    "Content-Type": "application/json; charset=utf-8",
    "Authorization": `Bearer ${auth.idTokenFull}`,
    "Cache-Control": "no-store",
    "x-superhuman-session-id": crypto.randomUUID(),
    "x-superhuman-request-id": crypto.randomUUID(),
    "x-superhuman-user-email": auth.email,
    "x-superhuman-user-external-id": auth.externalId,
    "x-superhuman-device-id": auth.deviceId || "cli-test",
    "x-superhuman-version": "2026-04-03T19:06:01Z",
  };

  const respNoCookie = await fetch("https://mail.superhuman.com/~backend/messages/send", {
    method: "POST",
    headers: headersNoCookie,
    body: JSON.stringify(requestBody),
  });
  const textNoCookie = await respNoCookie.text();
  console.log(`  Status: ${respNoCookie.status}`);
  console.log(`  Body: ${textNoCookie.substring(0, 200)}`);

  // Now send WITH cookies
  console.log("\nTest B: Send WITH cookies...");
  const headersWithCookie = {
    ...headersNoCookie,
    "x-superhuman-request-id": crypto.randomUUID(), // fresh request ID
    "Cookie": cookieStr,
  };

  const respWithCookie = await fetch("https://mail.superhuman.com/~backend/messages/send", {
    method: "POST",
    headers: headersWithCookie,
    body: JSON.stringify(requestBody),
  });
  const textWithCookie = await respWithCookie.text();
  console.log(`  Status: ${respWithCookie.status}`);
  console.log(`  Body: ${textWithCookie.substring(0, 200)}`);

  // Test C: Send with cookies + CSRF token
  const csrf = csrfCheck.result.value.csrfToken;
  if (csrf && typeof csrf === 'string' && !csrf.startsWith('ERROR')) {
    console.log("\nTest C: Send WITH cookies + CSRF token...");

    // New draft ID for this test
    const draftId2 = `draft00${Array.from({ length: 14 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
    const superhumanId2 = crypto.randomUUID();
    const rfc822Id2 = `<${Math.random().toString(36).substring(2, 10)}.${crypto.randomUUID()}@we.are.superhuman.com>`;

    const outMsg2 = { ...outgoingMessage, superhuman_id: superhumanId2, rfc822_id: rfc822Id2, thread_id: draftId2, message_id: draftId2, current_message_ids: [draftId2],
      headers: [
        { name: "X-Mailer", value: "Superhuman Web (2026-04-03T19:06:01Z)" },
        { name: "X-Superhuman-ID", value: superhumanId2 },
        { name: "X-Superhuman-Draft-ID", value: draftId2 },
        { name: "X-Superhuman-Thread-ID", value: draftId2 },
      ],
      subject: `Test send with CSRF ${new Date().toISOString().substring(11, 19)}`,
    };
    const reqBody2 = { version: 3, outgoing_message: outMsg2, delay: 0, is_multi_recipient: true };

    const headersWithCsrf = {
      ...headersNoCookie,
      "x-superhuman-request-id": crypto.randomUUID(),
      "Cookie": cookieStr,
      "x-csrf-token": csrf,
    };

    const respWithCsrf = await fetch("https://mail.superhuman.com/~backend/messages/send", {
      method: "POST",
      headers: headersWithCsrf,
      body: JSON.stringify(reqBody2),
    });
    const textWithCsrf = await respWithCsrf.text();
    console.log(`  Status: ${respWithCsrf.status}`);
    console.log(`  Body: ${textWithCsrf.substring(0, 200)}`);
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
