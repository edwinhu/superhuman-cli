#!/usr/bin/env bun
/**
 * Capture Superhuman Send Headers
 *
 * Monitors the background page network traffic and logs the FULL request headers
 * for all mail.superhuman.com requests. For messages/send specifically, also logs
 * the response status and body.
 *
 * The key piece missing from earlier captures: the Cookie header that the browser
 * sends, which may be required for messages/send to succeed from CLI context.
 *
 * Usage:
 *   bun run src/api-investigation/capture-send-headers.ts
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Capture Superhuman Send Headers");
  console.log("=".repeat(60));
  console.log("");
  console.log("Instructions:");
  console.log("1. In Superhuman (eddyhu@gmail.com), compose a test email to ehu@law.virginia.edu");
  console.log("2. Hit Cmd+Enter to send");
  console.log("3. Watch headers below — especially Cookie and Authorization");
  console.log("Monitoring for 90 seconds...");
  console.log("-".repeat(60));
  console.log("");

  // List all available CDP targets
  const targets = await CDP.List({ port: CDP_PORT });
  console.log("Available targets:");
  targets.forEach((t: { type: string; url: string }) =>
    console.log(`  - ${t.type}: ${t.url}`)
  );
  console.log("");

  // Connect to background page where API calls originate
  const bgPage = targets.find((t: { url: string }) =>
    t.url.includes("background_page")
  );

  if (!bgPage) {
    console.error("Background page not found. Is Superhuman running with CDP on port 9250?");
    process.exit(1);
  }

  console.log(`Monitoring background page: ${bgPage.url}`);
  console.log("");

  const client = await CDP({ target: bgPage.id, port: CDP_PORT });
  const { Network } = client;

  await Network.enable();

  // Track requestIds for messages/send so we can fetch their response bodies
  const sendRequestIds = new Set<string>();

  Network.requestWillBeSent((params: {
    requestId: string;
    request: {
      url: string;
      method: string;
      headers: Record<string, string>;
      postData?: string;
    };
  }) => {
    const { url, method, headers, postData } = params.request;

    // Only care about Superhuman backend requests
    if (!url.includes("mail.superhuman.com")) return;

    console.log(`[${method}] ${url}`);
    console.log("Headers:");

    for (const [key, value] of Object.entries(headers)) {
      // Truncate very long values (e.g. JWT) but keep enough to be useful
      const display = value.length > 120 ? value.substring(0, 120) + "..." : value;
      console.log(`  ${key}: ${display}`);
    }

    if (postData) {
      try {
        const body = JSON.parse(postData);
        console.log("Body:", JSON.stringify(body, null, 2).substring(0, 2000));
      } catch {
        console.log("Body (raw):", postData.substring(0, 500));
      }
    }

    console.log("");

    // Mark messages/send requests for response capture
    if (url.includes("messages/send")) {
      sendRequestIds.add(params.requestId);
    }
  });

  Network.responseReceived(async (params: {
    requestId: string;
    response: { status: number; url: string };
  }) => {
    if (!sendRequestIds.has(params.requestId)) return;

    console.log(`[RESPONSE] ${params.response.url}`);
    console.log(`Status: ${params.response.status}`);

    try {
      const body = await Network.getResponseBody({ requestId: params.requestId });
      if (body.body) {
        try {
          const json = JSON.parse(body.body);
          console.log("Response body:", JSON.stringify(json, null, 2).substring(0, 2000));
        } catch {
          console.log("Response body (raw):", body.body.substring(0, 500));
        }
      }
    } catch {
      console.log("(response body unavailable)");
    }

    console.log("-".repeat(40));
    console.log("");
  });

  // Run for 90 seconds
  await new Promise<void>(resolve => setTimeout(resolve, 90_000));

  console.log("\nCapture complete. Disconnecting...");
  await client.close();
}

main().catch(console.error);
