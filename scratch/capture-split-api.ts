#!/usr/bin/env bun
/**
 * Monitor Superhuman network requests to find the backend API
 * that serves split inbox classification (Important/Other).
 *
 * Captures requests from BOTH background page and main UI page.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  console.log("Available targets:");
  for (const t of targets) {
    console.log(`  [${t.type}] ${t.title} — ${t.url.slice(0, 80)}`);
  }

  // Find background page and main page
  const bgPage = targets.find(t => t.url.includes("background_page"));
  const mainPage = targets.find(t =>
    t.url.includes("mail.superhuman.com") && t.type === "page" &&
    !t.url.includes("background_page") && !t.url.includes("tabs.html")
  );

  const pagesToMonitor = [];
  if (bgPage) pagesToMonitor.push({ name: "BG", target: bgPage });
  if (mainPage) pagesToMonitor.push({ name: "UI", target: mainPage });

  if (pagesToMonitor.length === 0) {
    console.error("No Superhuman pages found");
    process.exit(1);
  }

  const clients: any[] = [];
  const requestBodies = new Map<string, string>();

  for (const page of pagesToMonitor) {
    const client = await CDP({ port: CDP_PORT, target: page.target.id });
    clients.push(client);

    await client.Network.enable();

    // Capture request bodies
    client.Network.requestWillBeSent((params: any) => {
      const url = params.request.url;
      // Only log Superhuman backend calls
      if (!url.includes("superhuman.com") && !url.includes("googleapis.com")) return;

      // Skip static assets
      if (url.match(/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/)) return;

      const method = params.request.method;
      const body = params.request.postData;

      // Look for thread-related or list-related API calls
      const isInteresting =
        url.includes("getThreads") ||
        url.includes("thread") ||
        url.includes("list") ||
        url.includes("inbox") ||
        url.includes("split") ||
        url.includes("important") ||
        url.includes("userdata") ||
        url.includes("classify") ||
        url.includes("triage") ||
        url.includes("move") ||
        url.includes("label") ||
        url.includes("gmail") ||
        url.includes("messages");

      if (isInteresting) {
        console.log(`\n[${page.name}] ${method} ${url.slice(0, 120)}`);
        if (body) {
          try {
            const parsed = JSON.parse(body);
            console.log("  Body:", JSON.stringify(parsed, null, 2).slice(0, 500));
          } catch {
            console.log("  Body:", body.slice(0, 300));
          }
        }
        if (params.request.headers) {
          // Show relevant headers
          for (const [k, v] of Object.entries(params.request.headers)) {
            if (k.toLowerCase().includes('content-type') || k.toLowerCase().includes('x-')) {
              console.log(`  ${k}: ${v}`);
            }
          }
        }
        requestBodies.set(params.requestId, url);
      }
    });

    // Capture responses for interesting requests
    client.Network.responseReceived((params: any) => {
      if (requestBodies.has(params.requestId)) {
        const url = requestBodies.get(params.requestId);
        console.log(`  → Response ${params.response.status} for ${url?.slice(0, 80)}`);
      }
    });

    console.log(`Monitoring ${page.name} page: ${page.target.url.slice(0, 60)}`);
  }

  console.log("\n=== Monitoring network requests for 60 seconds ===");
  console.log("=== Try switching between Important/Other tabs in Superhuman ===\n");

  // Wait and capture
  await new Promise(resolve => setTimeout(resolve, 60000));

  for (const client of clients) {
    await client.close();
  }
  console.log("\nDone monitoring.");
}

main().catch(console.error);
