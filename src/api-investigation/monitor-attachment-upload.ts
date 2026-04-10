#!/usr/bin/env bun
/**
 * Monitor Superhuman API calls during file attachment
 *
 * Usage:
 * 1. Make sure Superhuman is running with CDP: already on port 9400
 * 2. Run this script: bun src/api-investigation/monitor-attachment-upload.ts
 * 3. In Superhuman:
 *    - Open a compose/reply window
 *    - Attach a file (click paperclip icon or drag-and-drop)
 *    - Optionally send the draft
 * 4. Check console for captured API calls related to attachments
 *
 * We're looking for:
 * - The attachment upload endpoint
 * - The payload format (base64? multipart?)
 * - How attachments appear in userdata.writeMessage and messages/send
 */

import CDP from "chrome-remote-interface";

interface CapturedRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  timestamp: number;
}

const requests = new Map<string, CapturedRequest>();
const responseBodies = new Map<string, string>();

async function monitor() {
  console.log("Connecting to Superhuman on port 9400...\n");

  // List all targets
  const targets = await CDP.List({ port: 9400 });
  console.log("Available targets:");
  for (const t of targets) {
    console.log(`  [${t.type}] ${t.title || t.url}`);
  }

  // Find background page (where API calls happen)
  const bgTarget = targets.find(
    (t: any) =>
      t.url.includes("background") ||
      t.type === "background_page" ||
      t.type === "service_worker"
  );

  // Also find main page
  const mainTarget = targets.find(
    (t: any) =>
      t.url.includes("mail.superhuman.com") && t.type === "page"
  );

  if (!bgTarget && !mainTarget) {
    console.error("No suitable target found. Is Superhuman running?");
    process.exit(1);
  }

  const clients: any[] = [];

  // Monitor background page
  if (bgTarget) {
    console.log(`\nMonitoring background: ${bgTarget.url}`);
    const bgClient = await CDP({ port: 9400, target: bgTarget.id });
    await bgClient.Network.enable();
    setupListeners(bgClient, "BG");
    clients.push(bgClient);
  }

  // Monitor main page
  if (mainTarget) {
    console.log(`Monitoring main page: ${mainTarget.url}`);
    const mainClient = await CDP({ port: 9400, target: mainTarget.id });
    await mainClient.Network.enable();
    setupListeners(mainClient, "UI");
    clients.push(mainClient);
  }

  console.log("\n=== MONITORING FOR ATTACHMENT-RELATED API CALLS ===");
  console.log("Now attach a file in Superhuman (paperclip icon or drag-and-drop).");
  console.log("Also try sending the draft with attachment.");
  console.log("Press Ctrl+C to stop.\n");

  // Keep running
  process.on("SIGINT", async () => {
    console.log("\n\n=== SUMMARY ===");
    console.log(`Captured ${requests.size} relevant requests`);
    for (const [id, req] of requests) {
      console.log(`\n--- ${req.method} ${req.url} ---`);
      if (req.postData) {
        try {
          const parsed = JSON.parse(req.postData);
          console.log("Request body:", JSON.stringify(parsed, null, 2));
        } catch {
          // Might be multipart or binary
          const preview = req.postData.substring(0, 500);
          console.log(`Request body (preview): ${preview}`);
          if (req.postData.length > 500) {
            console.log(`... (${req.postData.length} total chars)`);
          }
        }
      }
      const respBody = responseBodies.get(id);
      if (respBody) {
        try {
          const parsed = JSON.parse(respBody);
          console.log("Response body:", JSON.stringify(parsed, null, 2));
        } catch {
          console.log(`Response body (preview): ${respBody.substring(0, 300)}`);
        }
      }
    }

    for (const c of clients) {
      await c.close();
    }
    process.exit(0);
  });
}

function setupListeners(client: any, label: string) {
  const { Network } = client;

  // Track ALL requests to find attachment-related ones
  Network.requestWillBeSent((params: any) => {
    const url: string = params.request.url;

    // Broad filter: capture anything that might be attachment-related
    const isRelevant =
      // Superhuman backend calls
      (url.includes("superhuman.com") &&
        (url.includes("attach") ||
          url.includes("upload") ||
          url.includes("file") ||
          url.includes("blob") ||
          url.includes("writeMessage") ||
          url.includes("messages/send"))) ||
      // Gmail API calls (direct, not through superhuman.com)
      url.includes("googleapis.com/upload") ||
      url.includes("googleapis.com/gmail") ||
      // MS Graph API calls
      url.includes("graph.microsoft.com") ||
      // Firebase/storage uploads
      url.includes("firebasestorage.googleapis.com") ||
      url.includes("storage.googleapis.com");

    if (!isRelevant) return;

    const req: CapturedRequest = {
      requestId: params.requestId,
      url,
      method: params.request.method,
      headers: params.request.headers,
      postData: params.request.postData,
      timestamp: Date.now(),
    };

    requests.set(params.requestId, req);

    // Log immediately for real-time feedback
    console.log(`[${label}] ${req.method} ${url}`);
    if (req.postData) {
      try {
        const parsed = JSON.parse(req.postData);
        // Look specifically for attachment fields
        const attachStr = JSON.stringify(parsed);
        if (
          attachStr.includes("attach") ||
          attachStr.includes("file") ||
          attachStr.includes("content_type") ||
          attachStr.includes("contentType") ||
          attachStr.includes("base64") ||
          attachStr.includes("upload")
        ) {
          console.log(`  [${label}] ATTACHMENT DATA FOUND in request body!`);
          console.log(`  ${JSON.stringify(parsed, null, 2).substring(0, 2000)}`);
        } else if (url.includes("writeMessage") || url.includes("messages/send")) {
          // Always log writeMessage and send payloads
          console.log(`  [${label}] Payload: ${JSON.stringify(parsed, null, 2).substring(0, 3000)}`);
        }
      } catch {
        // Check if it's multipart form data
        if (req.postData.includes("boundary") || req.postData.includes("Content-Disposition")) {
          console.log(`  [${label}] MULTIPART UPLOAD detected`);
          console.log(`  ${req.postData.substring(0, 1000)}`);
        }
      }
    }
  });

  // Capture response bodies
  Network.responseReceived(async (params: any) => {
    if (!requests.has(params.requestId)) return;

    try {
      const body = await Network.getResponseBody({
        requestId: params.requestId,
      });
      responseBodies.set(params.requestId, body.body);

      const url = requests.get(params.requestId)?.url || "";
      console.log(`  [${label}] Response ${params.response.status} for ${url}`);

      // Log response for relevant endpoints
      if (body.body) {
        try {
          const parsed = JSON.parse(body.body);
          const bodyStr = JSON.stringify(parsed);
          if (
            bodyStr.includes("attach") ||
            bodyStr.includes("upload") ||
            url.includes("writeMessage") ||
            url.includes("messages/send")
          ) {
            console.log(`  [${label}] Response: ${JSON.stringify(parsed, null, 2).substring(0, 1000)}`);
          }
        } catch {
          // binary response
        }
      }
    } catch {
      // Response body not available yet
    }
  });
}

monitor().catch(console.error);
