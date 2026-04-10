#!/usr/bin/env bun
/**
 * Capture the actual messages/send request when the app sends an email.
 * Monitors BOTH main page AND service worker network traffic.
 * 
 * Run this script, then send a test email from Superhuman UI.
 */
import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function monitorTarget(targetId: string, label: string) {
  const client = await CDP({ target: targetId, port: CDP_PORT });
  const { Network } = client;
  
  await Network.enable({ maxPostDataSize: 100000 });
  
  Network.requestWillBeSent((params: any) => {
    if (params.request.url.includes("messages/send")) {
      console.log(`\n[${label}] === SEND REQUEST ===`);
      console.log("URL:", params.request.url);
      console.log("Method:", params.request.method);
      console.log("Headers:", JSON.stringify(params.request.headers, null, 2));
      if (params.request.postData) {
        try {
          const body = JSON.parse(params.request.postData);
          const pretty = JSON.stringify(body, null, 2);
          console.log("Body:", pretty.substring(0, 3000));
        } catch {
          console.log("Body (raw):", params.request.postData.substring(0, 2000));
        }
      }
      console.log("RequestId:", params.requestId);
    }
  });
  
  Network.responseReceived(async (params: any) => {
    if (params.response.url.includes("messages/send")) {
      console.log(`\n[${label}] === SEND RESPONSE ===`);
      console.log("Status:", params.response.status);
      try {
        const body = await Network.getResponseBody({ requestId: params.requestId });
        console.log("Body:", body.body?.substring(0, 500));
      } catch {}
    }
  });
  
  return client;
}

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  const bgWorker = targets.find((t: any) => t.url.includes("background_page") && t.type === "service_worker");
  
  console.log("=== Capturing messages/send from ALL contexts ===");
  console.log("Main page:", mainPage?.url);
  console.log("Service worker:", bgWorker?.url);
  console.log("");
  console.log("NOW: Please compose and send a test email in Superhuman (any email to ehu@law.virginia.edu)");
  console.log("Monitoring for 120 seconds...");
  console.log("-".repeat(60));
  
  const clients: any[] = [];
  
  if (mainPage) {
    clients.push(await monitorTarget(mainPage.id, "MAIN"));
  }
  if (bgWorker) {
    clients.push(await monitorTarget(bgWorker.id, "SW"));
  }
  
  // Also monitor all OTHER targets (iframes, workers)
  for (const t of targets) {
    if (t.id !== mainPage?.id && t.id !== bgWorker?.id && t.type !== "worker") {
      try {
        const c = await CDP({ target: t.id, port: CDP_PORT });
        const { Network: N } = c;
        await N.enable({ maxPostDataSize: 100000 });
        N.requestWillBeSent((params: any) => {
          if (params.request.url.includes("messages/send")) {
            console.log(`\n[${t.type}:${t.url.substring(0,50)}] SEND REQUEST`);
            console.log("Body:", params.request.postData?.substring(0, 1000));
          }
        });
        clients.push(c);
      } catch {}
    }
  }
  
  await new Promise(resolve => setTimeout(resolve, 120_000));
  
  for (const c of clients) {
    try { await c.close(); } catch {}
  }
  
  console.log("\nDone.");
}

main().catch(console.error);
