#!/usr/bin/env bun
/**
 * Monitor network calls while switching between Important/Other inbox tabs.
 * Also inspect thread presenters for list membership fields.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const bgPage = targets.find(t => t.url.includes("background_page.html"));
  const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page");

  if (!bgPage || !mainPage) {
    console.error("Missing pages");
    process.exit(1);
  }

  // Connect to background page for network monitoring
  const bgClient = await CDP({ port: CDP_PORT, target: bgPage.id });
  const { Network: BgNetwork } = bgClient;
  await BgNetwork.enable();

  const capturedCalls: any[] = [];

  BgNetwork.requestWillBeSent(({ requestId, request }) => {
    if (request.url.includes("/~backend/") && request.postData) {
      try {
        const body = JSON.parse(request.postData);
        capturedCalls.push({ url: request.url, body, requestId, timestamp: Date.now() });
        console.log(`\n>>> ${request.method} ${request.url}`);
        console.log("    Body:", JSON.stringify(body, null, 2).slice(0, 1000));
      } catch {}
    }
  });

  BgNetwork.responseReceived(async ({ requestId, response }) => {
    const call = capturedCalls.find(c => c.requestId === requestId);
    if (!call) return;

    try {
      const body = await BgNetwork.getResponseBody({ requestId });
      const parsed = JSON.parse(body.body);
      console.log(`\n<<< ${response.status} ${call.url}`);

      // For threadList responses, dump thread structure
      if (parsed.threadList && parsed.threadList.length > 0) {
        console.log(`    Thread count: ${parsed.threadList.length}`);
        const first = parsed.threadList[0];
        console.log(`    First thread keys:`, Object.keys(first));
        if (first.thread) {
          console.log(`    thread.keys:`, Object.keys(first.thread));
          // Look for any messages
          if (first.thread.messages) {
            const msgKeys = Object.keys(first.thread.messages);
            console.log(`    thread.messages count:`, msgKeys.length);
            if (msgKeys.length > 0) {
              const firstMsg = first.thread.messages[msgKeys[0]];
              console.log(`    First message keys:`, Object.keys(firstMsg));
              // Look for list/section fields
              const sample = {};
              for (const k of Object.keys(firstMsg)) {
                const v = firstMsg[k];
                if (typeof v === 'string') sample[k] = v.slice(0, 100);
                else if (typeof v === 'number' || typeof v === 'boolean') sample[k] = v;
                else if (Array.isArray(v)) sample[k] = v.length <= 5 ? v : `[Array(${v.length})]`;
                else if (v === null) sample[k] = null;
                else sample[k] = typeof v;
              }
              console.log(`    First message sample:`, JSON.stringify(sample, null, 2));
            }
          }
          // Check for listIds directly on thread
          for (const k of Object.keys(first.thread)) {
            const v = first.thread[k];
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              if (k.toLowerCase().includes("list") || k.toLowerCase().includes("section") ||
                  k.toLowerCase().includes("type") || k.toLowerCase().includes("label") ||
                  k.toLowerCase().includes("bucket") || k.toLowerCase().includes("split") ||
                  k.toLowerCase().includes("import") || k.toLowerCase().includes("sort") ||
                  k.toLowerCase().includes("historyId")) {
                console.log(`    thread.${k}:`, v);
              }
            }
          }
          // Dump full first thread (without message bodies)
          const threadClean = { ...first.thread };
          delete threadClean.messages;
          console.log(`    Thread (sans messages):`, JSON.stringify(threadClean, null, 2).slice(0, 1000));
        }
        // Check for metadata alongside threadList
        const topKeys = Object.keys(parsed);
        console.log(`    Response top-level keys:`, topKeys);
        for (const k of topKeys) {
          if (k !== 'threadList') {
            console.log(`    ${k}:`, JSON.stringify(parsed[k]).slice(0, 200));
          }
        }
      } else {
        console.log(`    Response:`, JSON.stringify(parsed, null, 2).slice(0, 500));
      }
    } catch (e) {}
  });

  // Now connect to main page and navigate to "Other" tab
  const uiClient = await CDP({ port: CDP_PORT, target: mainPage.id });
  const { Runtime } = uiClient;

  // First let's inspect what the thread presenter/baobab actually looks like
  console.log("=== Inspecting Thread Presenter Baobab ===");
  const baobabResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const threads = ga.threads;
        if (!threads || !threads.identityMap) return { error: "No identityMap" };

        // The identityMap seems to be a Baobab tree
        const tree = threads.identityMap;
        if (tree.cache) {
          const cache = tree.cache;
          const threadIds = Object.keys(cache);
          if (threadIds.length === 0) return { error: "Empty cache" };

          const firstId = threadIds[0];
          const thread = cache[firstId];
          if (!thread) return { error: "Null first thread" };

          // Get all keys recursively (one level deep)
          const result = {
            threadId: firstId,
            topKeys: Object.keys(thread),
          };

          // Dump the thread object
          const dump = {};
          for (const k of Object.keys(thread)) {
            const v = thread[k];
            if (v === null || v === undefined) dump[k] = v;
            else if (typeof v === 'string') dump[k] = v.slice(0, 200);
            else if (typeof v === 'number' || typeof v === 'boolean') dump[k] = v;
            else if (Array.isArray(v)) {
              if (v.length <= 10 && v.every(x => typeof x === 'string' || typeof x === 'number')) {
                dump[k] = v;
              } else {
                dump[k] = '[Array(' + v.length + ')]';
              }
            }
            else if (typeof v === 'object') {
              const subKeys = Object.keys(v);
              if (subKeys.length <= 10) {
                const sub = {};
                for (const sk of subKeys) {
                  const sv = v[sk];
                  if (typeof sv === 'string') sub[sk] = sv.slice(0, 100);
                  else if (typeof sv === 'number' || typeof sv === 'boolean' || sv === null) sub[sk] = sv;
                  else sub[sk] = typeof sv;
                }
                dump[k] = sub;
              } else {
                dump[k] = '{' + subKeys.slice(0, 10).join(',') + '...(' + subKeys.length + ')}';
              }
            }
          }
          result.dump = dump;

          return result;
        }

        return { error: "No cache on identityMap" };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(baobabResult.result?.value, null, 2));

  // Navigate to "Other" inbox to trigger API calls
  console.log("\n\n=== Navigating to Other inbox... ===");
  await Runtime.evaluate({
    expression: `window.GoogleAccount.navigateTo('/eddyhu@gmail.com/inbox/other')`,
    awaitPromise: true,
  });

  await new Promise(r => setTimeout(r, 5000));

  // Navigate to "Important" inbox
  console.log("\n\n=== Navigating to Important inbox... ===");
  await Runtime.evaluate({
    expression: `window.GoogleAccount.navigateTo('/eddyhu@gmail.com/inbox/important')`,
    awaitPromise: true,
  });

  await new Promise(r => setTimeout(r, 5000));

  console.log("\n=== Done monitoring. Captured", capturedCalls.length, "API calls ===");

  await bgClient.close();
  await uiClient.close();
}

main().catch(console.error);
