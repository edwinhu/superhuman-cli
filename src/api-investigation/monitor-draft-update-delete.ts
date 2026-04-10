#!/usr/bin/env bun
/**
 * Monitor Superhuman API calls for draft UPDATE and DELETE operations
 * 
 * Usage:
 * 1. Start Superhuman with: /Applications/Superhuman.app/Contents/MacOS/Superhuman --remote-debugging-port=9333
 * 2. Run this script: bun src/api-investigation/monitor-draft-update-delete.ts
 * 3. In Superhuman:
 *    - Create a draft
 *    - Edit the draft (change subject/body)
 *    - Delete the draft
 * 4. Check console for captured API calls
 */

import CDP from "chrome-remote-interface";

interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
}

interface NetworkResponse {
  requestId: string;
  status: number;
  headers: Record<string, string>;
}

const requests = new Map<string, NetworkRequest>();
const responses = new Map<string, string>();

async function monitor() {
  console.log("Connecting to Superhuman...\n");

  const client = await CDP({ port: 9333 });
  const { Network } = client;

  await Network.enable();

  // Capture request details
  Network.requestWillBeSent((params: any) => {
    const url = params.request.url;

    // Only track Superhuman backend API calls
    if (!url.includes("superhuman.com/~backend")) {
      return;
    }

    requests.set(params.requestId, {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers,
      postData: params.request.postData,
    });
  });

  // Capture response body
  Network.responseReceived(async (params: any) => {
    const url = params.response.url;

    if (!url.includes("superhuman.com/~backend")) {
      return;
    }

    try {
      const body = await Network.getResponseBody({ requestId: params.requestId });
      responses.set(params.requestId, body.body);
    } catch (err) {
      // Some responses can't be captured
    }
  });

  // Log completed requests
  Network.loadingFinished((params: any) => {
    const request = requests.get(params.requestId);
    const responseBody = responses.get(params.requestId);

    if (!request) {
      return;
    }

    // Filter for draft-related endpoints
    const url = request.url;
    if (
      url.includes("userdata.writeMessage") ||
      url.includes("userdata.delete") ||
      url.includes("userdata.remove") ||
      url.includes("userdata.update") ||
      url.includes("draft")
    ) {
      console.log("━".repeat(80));
      console.log(`${request.method} ${url}`);
      console.log("━".repeat(80));

      if (request.postData) {
        console.log("\n📤 Request Body:");
        try {
          const parsed = JSON.parse(request.postData);
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(request.postData);
        }
      }

      if (responseBody) {
        console.log("\n📥 Response Body:");
        try {
          const parsed = JSON.parse(responseBody);
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(responseBody);
        }
      }

      console.log("\n");
    }

    // Clean up
    requests.delete(params.requestId);
    responses.delete(params.requestId);
  });

  console.log("🔍 Monitoring Superhuman API calls...");
  console.log("👉 Now edit or delete a draft in Superhuman\n");

  // Keep process running
  await new Promise(() => {});
}

monitor().catch(console.error);
