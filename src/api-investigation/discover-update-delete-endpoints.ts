#!/usr/bin/env bun
/**
 * Monitor background page for draft UPDATE and DELETE API calls
 */

import CDP from "chrome-remote-interface";
import { loadTokensFromDisk, getCachedToken } from "../token-api";
import { createDraftWithUserInfo, getUserInfoFromCache } from "../draft-api";

async function discover() {
  console.log("🔧 Loading tokens...\n");
  await loadTokensFromDisk();

  const email = "eddyhu@gmail.com";
  const token = await getCachedToken(email);

  if (!token || !token.superhumanToken || !token.userId) {
    console.error("❌ Token missing required fields");
    process.exit(1);
  }

  const userInfo = getUserInfoFromCache(
    token.userId,
    email,
    token.superhumanToken.token,
    "Eddy Hu"
  );

  console.log("📝 Creating test draft...\n");

  const result = await createDraftWithUserInfo(userInfo, {
    to: ["test-discovery@example.com"],
    subject: "[TEST] Draft for API Discovery",
    body: "This draft will be updated and deleted to discover endpoints",
  });

  if (!result.success) {
    console.error("❌ Failed to create draft:", result.error);
    process.exit(1);
  }

  console.log(`✅ Created draft: ${result.draftId}`);
  console.log(`   Thread: ${result.threadId}\n`);

  // Find the background page
  console.log("🔍 Finding Superhuman background page...\n");
  const targets = await CDP.List({ port: 9333 });
  const backgroundPage = targets.find(t => 
    t.url.includes("background_page.html")
  );

  if (!backgroundPage) {
    console.error("❌ Background page not found");
    process.exit(1);
  }

  console.log(`✅ Found background page: ${backgroundPage.id}\n`);
  console.log("🔌 Connecting to background page...\n");

  const client = await CDP({ port: 9333, target: backgroundPage.id });
  const { Network } = client;

  await Network.enable();

  const requests = new Map<string, any>();
  const responses = new Map<string, string>();

  let callCount = 0;

  Network.requestWillBeSent((params: any) => {
    if (params.request.url.includes("superhuman.com/~backend")) {
      requests.set(params.requestId, params.request);
    }
  });

  Network.responseReceived(async (params: any) => {
    if (params.response.url.includes("superhuman.com/~backend")) {
      try {
        const body = await Network.getResponseBody({ requestId: params.requestId });
        responses.set(params.requestId, body.body);
      } catch {}
    }
  });

  Network.loadingFinished((params: any) => {
    const request = requests.get(params.requestId);
    const responseBody = responses.get(params.requestId);

    if (request) {
      callCount++;
      console.log("\n" + "━".repeat(80));
      console.log(`#${callCount} ${request.method} ${request.url}`);
      console.log("━".repeat(80));

      if (request.postData) {
        console.log("\n📤 Request:");
        try {
          const parsed = JSON.parse(request.postData);
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(request.postData.substring(0, 500));
        }
      }

      if (responseBody) {
        console.log("\n📥 Response:");
        try {
          const parsed = JSON.parse(responseBody);
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(responseBody.substring(0, 500));
        }
      }

      console.log("");
    }

    requests.delete(params.requestId);
    responses.delete(params.requestId);
  });

  console.log("👉 Now in Superhuman:");
  console.log("   1. Find the draft '[TEST] Draft for API Discovery'");
  console.log("   2. Edit it (change subject or body)");
  console.log("   3. Delete it");
  console.log("\n🔍 Monitoring background page... (Press Ctrl+C when done)\n");

  // Keep running
  await new Promise(() => {});
}

discover().catch(console.error);
