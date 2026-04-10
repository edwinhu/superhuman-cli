#!/usr/bin/env bun
/**
 * Test messages/send with Gmail account using object format
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Test Gmail Send with Object Format");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime } = client;

  // Switch to Gmail account first
  const switchResult = await Runtime.evaluate({
    expression: `
      (async () => {
        // Check current account
        const currentEmail = window.GoogleAccount?.emailAddress;
        if (currentEmail === "eddyhu@gmail.com") {
          return { alreadyOnGmail: true };
        }
        // Need to get the Gmail account's credential
        // Actually, let's just get the token from the SW
        return { currentEmail, needSwitch: true };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("Switch:", JSON.stringify(switchResult.result.value));

  // Get Gmail token from the service worker
  const sw = targets.find((t: any) => t.type === "service_worker");
  if (!sw) {
    console.error("No service worker");
    process.exit(1);
  }

  const swClient = await CDP({ target: sw.id, port: CDP_PORT, host });

  // Intercept a backend request to capture the Gmail JWT
  const tokenResult = await swClient.Runtime.evaluate({
    expression: `
      (async () => {
        const email = "eddyhu@gmail.com";
        const bg = backgrounds?.[email]?._accountBackground;
        if (!bg) return { error: "No bg for Gmail" };

        // Try to get credential
        // The background uses requestBackground to communicate with the offscreen page
        // which has the actual credential

        // Alternative: capture the token from a network request
        // Let's try the query method
        try {
          const result = await bg.query({ type: "getAuthData" });
          return { result };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("Token result:", JSON.stringify(tokenResult.result.value, null, 2));

  // Intercept via Fetch
  const { Fetch } = swClient;
  let gmailToken = "";
  let gmailExternalId = "";

  await Fetch.enable({
    patterns: [{ urlPattern: "*superhuman.com/~backend*" }],
  });

  const capturePromise = new Promise<void>((resolve) => {
    Fetch.requestPaused(async (params: any) => {
      const auth = params.request.headers["Authorization"] || "";
      const email = params.request.headers["x-superhuman-user-email"] || "";
      const extId = params.request.headers["x-superhuman-user-external-id"] || "";

      if (email === "eddyhu@gmail.com" && auth.startsWith("Bearer ")) {
        gmailToken = auth.replace("Bearer ", "");
        gmailExternalId = extId;
        console.log("Captured Gmail token from SW request");
      }

      await Fetch.continueRequest({ requestId: params.requestId });
      if (gmailToken) resolve();
    });
  });

  // Trigger a request for the Gmail account
  await swClient.Runtime.evaluate({
    expression: `
      (() => {
        const bg = backgrounds?.["eddyhu@gmail.com"]?._accountBackground;
        if (bg?.ping) bg.ping().catch(() => {});
      })()
    `,
  });

  // Wait with timeout
  await Promise.race([capturePromise, new Promise(r => setTimeout(r, 5000))]);
  await Fetch.disable();

  if (!gmailToken) {
    console.log("Could not capture Gmail token from SW. Trying main page...");

    // Try to get token by switching account on main page
    const switchAndGet = await Runtime.evaluate({
      expression: `
        (async () => {
          // Try to switch to Gmail account
          const result = await window.Superhuman?.switchAccount?.("eddyhu@gmail.com");
          await new Promise(r => setTimeout(r, 2000));

          const ga = window.GoogleAccount;
          const cred = ga?.backend?._credential || ga?.credential;
          const idToken = await cred?.getIDTokenAsync?.();
          const externalId = cred?.getExternalId?.();

          return {
            email: ga?.emailAddress,
            idToken,
            externalId,
            userId: cred?.user?._id,
          };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });

    const g = switchAndGet.result.value;
    console.log(`Switched to: ${g.email}`);

    if (g.email === "eddyhu@gmail.com" && g.idToken) {
      gmailToken = g.idToken;
      gmailExternalId = g.externalId;

      // Send test
      const draftId = `draft00${Array.from({ length: 14 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
      const threadId = `draft00${Array.from({ length: 14 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
      const shId = `${Math.random().toString(36).substring(2, 10)}.${crypto.randomUUID()}`;
      const rfc822 = `<${Math.random().toString(36).substring(2, 10)}.${crypto.randomUUID()}@we.are.superhuman.com>`;

      console.log("\nSending from Gmail account...");
      const resp = await fetch("https://mail.superhuman.com/~backend/messages/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Authorization": `Bearer ${gmailToken}`,
          "Cache-Control": "no-store",
          "x-superhuman-session-id": `background-${crypto.randomUUID()}`,
          "x-superhuman-request-id": crypto.randomUUID(),
          "x-superhuman-user-email": "eddyhu@gmail.com",
          "x-superhuman-user-external-id": gmailExternalId,
          "x-superhuman-version": "2026-04-03T19:06:01Z",
        },
        body: JSON.stringify({
          version: 3,
          outgoing_message: {
            headers: [
              { name: "X-Mailer", value: "Superhuman Web (2026-04-03T19:06:01Z)" },
              { name: "X-Superhuman-ID", value: shId },
              { name: "X-Superhuman-Draft-ID", value: draftId },
              { name: "X-Superhuman-Thread-ID", value: threadId },
            ],
            superhuman_id: shId,
            rfc822_id: rfc822,
            thread_id: threadId,
            message_id: draftId,
            in_reply_to: null,
            from: { email: "eddyhu@gmail.com", name: "eddyhu" },
            to: [{ email: "ehu@law.virginia.edu" }],
            cc: [],
            bcc: [],
            subject: `Gmail send test ${new Date().toISOString().substring(11, 19)}`,
            html_body: "<div>Test from Gmail account with object format</div>",
            attachments: [],
            scheduled_for: null,
            abort_on_reply: false,
            current_message_ids: [draftId],
            mail_merge_recipients: [],
          },
          delay: 0,
          is_multi_recipient: true,
        }),
      });

      const text = await resp.text();
      console.log(`Status: ${resp.status}`);
      console.log(`Body: ${text}`);
    }
  }

  await swClient.close();
  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
