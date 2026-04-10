#!/usr/bin/env bun
/**
 * Capture a REAL send from Superhuman UI via CDP Network monitoring.
 *
 * FINDING: Even backend.sendEmail() from browser context fails with 520
 * when using a duck-typed OutgoingMessage. We need to see what a REAL
 * OutgoingMessage.toJsonRequest() produces vs our mock.
 *
 * This script:
 * 1. Monitors ALL network traffic to messages/send (including log)
 * 2. Waits for the user to send a real email from the Superhuman UI
 * 3. Captures the exact request payload and response
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Capture REAL Send from Superhuman UI");
  console.log("=".repeat(60));
  console.log("");
  console.log("Instructions:");
  console.log("1. Open Superhuman (eddyhu@gmail.com)");
  console.log("2. Compose a test email to ehu@law.virginia.edu");
  console.log("3. Hit Cmd+Enter to send");
  console.log("4. This script will capture the exact payload");
  console.log("");
  console.log("Monitoring for 120 seconds...");
  console.log("-".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });

  // Monitor ALL pages that might send
  const pages = targets.filter((t: any) =>
    t.url.includes("mail.superhuman.com") ||
    t.url.includes("background_page") ||
    t.url.includes("offscreen")
  );

  console.log("\nMonitoring pages:");
  for (const p of pages) {
    console.log(`  [${p.type}] ${p.url.substring(0, 80)}`);
  }
  console.log("");

  const clients: any[] = [];

  for (const page of pages) {
    try {
      const c = await CDP({ target: page.id, port: CDP_PORT, host });
      await c.Network.enable();
      clients.push(c);

      c.Network.requestWillBeSent((params: any) => {
        const { url, method, headers, postData } = params.request;
        if (!url.includes("messages/send")) return;

        console.log(`\n${"=".repeat(60)}`);
        console.log(`[${page.type}] ${method} ${url}`);
        console.log(`${"=".repeat(60)}`);
        console.log("\nHeaders:");
        for (const [k, v] of Object.entries(headers as Record<string, string>)) {
          if (k.toLowerCase() === 'authorization') {
            console.log(`  ${k}: Bearer <JWT truncated>`);
          } else if (k.toLowerCase() === 'cookie') {
            console.log(`  ${k}: <${v.length} chars>`);
          } else {
            console.log(`  ${k}: ${v}`);
          }
        }

        if (postData) {
          console.log("\nRequest Body:");
          try {
            const body = JSON.parse(postData);
            console.log(JSON.stringify(body, null, 2));
          } catch {
            console.log(postData.substring(0, 3000));
          }
        }
      });

      c.Network.responseReceived(async (params: any) => {
        if (!params.response.url.includes("messages/send")) return;

        console.log(`\n--- RESPONSE from ${params.response.url} ---`);
        console.log(`Status: ${params.response.status}`);

        try {
          const body = await c.Network.getResponseBody({ requestId: params.requestId });
          console.log(`Body: ${body.body?.substring(0, 1000)}`);
        } catch {
          console.log("(body unavailable)");
        }
      });
    } catch (e) {
      console.log(`  Failed to connect to ${page.url}: ${e}`);
    }
  }

  // Also monitor the service worker
  const sw = targets.find((t: any) => t.type === "service_worker");
  if (sw) {
    try {
      const swc = await CDP({ target: sw.id, port: CDP_PORT, host });
      await swc.Network.enable();
      clients.push(swc);

      swc.Network.requestWillBeSent((params: any) => {
        const { url, method, postData } = params.request;
        if (!url.includes("messages/send")) return;

        console.log(`\n${"=".repeat(60)}`);
        console.log(`[service_worker] ${method} ${url}`);
        console.log(`${"=".repeat(60)}`);

        if (postData) {
          console.log("\nRequest Body:");
          try {
            const body = JSON.parse(postData);
            console.log(JSON.stringify(body, null, 2));
          } catch {
            console.log(postData.substring(0, 3000));
          }
        }
      });

      swc.Network.responseReceived(async (params: any) => {
        if (!params.response.url.includes("messages/send")) return;
        console.log(`\n--- [SW] RESPONSE ${params.response.status} from ${params.response.url} ---`);
        try {
          const body = await swc.Network.getResponseBody({ requestId: params.requestId });
          console.log(`Body: ${body.body?.substring(0, 1000)}`);
        } catch {
          console.log("(body unavailable)");
        }
      });
    } catch {}
  }

  // Wait for user to send
  await new Promise<void>(resolve => setTimeout(resolve, 120_000));

  console.log("\n\nCapture complete. Closing connections...");
  for (const c of clients) {
    await c.close().catch(() => {});
  }
}

main().catch(console.error);
