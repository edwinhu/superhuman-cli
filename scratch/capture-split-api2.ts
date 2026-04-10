#!/usr/bin/env bun
/**
 * Navigate Superhuman to inbox → Important → Other while monitoring network.
 * Also try calling userdata.getThreads with different parameters.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });

  const bgPage = targets.find(t => t.url.includes("background_page"));
  const mainPage = targets.find(t =>
    t.url.includes("mail.superhuman.com") && t.type === "page" &&
    !t.url.includes("background_page") && !t.url.includes("tabs.html")
  );

  if (!bgPage || !mainPage) {
    console.error("Need both BG and UI pages");
    process.exit(1);
  }

  // Monitor background page network
  const bgClient = await CDP({ port: CDP_PORT, target: bgPage.id });
  await bgClient.Network.enable();

  const capturedRequests: any[] = [];

  bgClient.Network.requestWillBeSent((params: any) => {
    const url = params.request.url;
    if (url.match(/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/)) return;
    if (url.includes("metrics.write")) return;

    const method = params.request.method;
    const body = params.request.postData;

    capturedRequests.push({
      method,
      url: url.slice(0, 150),
      body: body ? body.slice(0, 500) : null,
    });

    console.log(`[BG] ${method} ${url.slice(0, 120)}`);
    if (body) {
      try {
        console.log("  Body:", JSON.stringify(JSON.parse(body), null, 2).slice(0, 400));
      } catch {
        console.log("  Body:", body.slice(0, 200));
      }
    }
  });

  // Also monitor UI page network
  const uiClient = await CDP({ port: CDP_PORT, target: mainPage.id });
  await uiClient.Network.enable();

  uiClient.Network.requestWillBeSent((params: any) => {
    const url = params.request.url;
    if (url.match(/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/)) return;
    if (url.includes("metrics.write")) return;

    const method = params.request.method;
    const body = params.request.postData;

    console.log(`[UI] ${method} ${url.slice(0, 120)}`);
    if (body) {
      try {
        console.log("  Body:", JSON.stringify(JSON.parse(body), null, 2).slice(0, 400));
      } catch {
        console.log("  Body:", body.slice(0, 200));
      }
    }
  });

  console.log("=== Network monitoring active ===\n");

  // 1. First, check what the backend object has
  console.log("=== Exploring backend methods ===\n");
  const r1 = await uiClient.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend) return { error: "No backend" };

        // List all methods on backend
        const methods = [];
        let obj = backend;
        while (obj && obj !== Object.prototype) {
          for (const key of Object.getOwnPropertyNames(obj)) {
            if (typeof obj[key] === 'function' && !key.startsWith('_')) {
              methods.push(key);
            }
          }
          obj = Object.getPrototypeOf(obj);
        }

        // Filter for thread/list/split related methods
        const interesting = methods.filter(m => {
          const ml = m.toLowerCase();
          return ml.includes('thread') || ml.includes('list') || ml.includes('split') ||
                 ml.includes('inbox') || ml.includes('important') || ml.includes('classify') ||
                 ml.includes('triage') || ml.includes('move') || ml.includes('userdata') ||
                 ml.includes('getthread');
        });

        return {
          totalMethods: methods.length,
          interestingMethods: interesting,
          allMethods: methods.sort(),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r1.result?.value, null, 2));

  // 2. Check the listRouter and how it fetches data
  console.log("\n=== listRouter methods and state ===\n");
  const r2 = await uiClient.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr) return { error: "No listRouter" };

        const ownKeys = Object.keys(lr);
        const proto = Object.getPrototypeOf(lr);
        const protoKeys = proto ? Object.getOwnPropertyNames(proto).filter(k => k !== 'constructor') : [];

        // Get scalar values
        const scalars = {};
        for (const k of ownKeys) {
          const v = lr[k];
          if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            scalars[k] = v;
          } else if (typeof v === 'function') {
            scalars[k] = '[fn]';
          } else if (Array.isArray(v)) {
            scalars[k] = '[Array(' + v.length + ')]';
          } else {
            scalars[k] = '[obj: ' + Object.keys(v).slice(0, 8).join(',') + ']';
          }
        }

        return {
          ownKeys,
          protoMethods: protoKeys,
          scalars,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r2.result?.value, null, 2));

  // 3. Check disk.list — how does it load lists from disk/server?
  console.log("\n=== disk.list methods ===\n");
  const r3 = await uiClient.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const diskList = ga?.disk?.list;
        if (!diskList) return { error: "No disk.list" };

        const proto = Object.getPrototypeOf(diskList);
        const methods = proto ? Object.getOwnPropertyNames(proto).filter(k => k !== 'constructor') : [];

        return { methods };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r3.result?.value, null, 2));

  // 4. Try to call disk.list.getAsync for SH_IMPORTANT — this should trigger a backend call
  console.log("\n=== Triggering disk.list.getAsync('SH_IMPORTANT') ===\n");
  await new Promise(resolve => setTimeout(resolve, 1000));

  const r4 = await uiClient.Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const diskList = ga?.disk?.list;
        if (!diskList?.getAsync) return { error: "No getAsync" };

        try {
          const result = await diskList.getAsync('SH_IMPORTANT');
          if (!result) return { result: null };

          return {
            type: typeof result,
            keys: Object.keys(result).slice(0, 20),
            threadIds: result.threadIds ? result.threadIds.slice(0, 10) : null,
            count: result.threadIds?.length || result.count,
          };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("disk.list.getAsync result:", JSON.stringify(r4.result?.value, null, 2));

  // Wait a moment to capture any network requests triggered by getAsync
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 5. Try threads.listAsync which should definitely trigger network
  console.log("\n=== Triggering threads.listAsync('SH_IMPORTANT') ===\n");
  const r5 = await uiClient.Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const threads = ga?.threads;
        if (!threads?.listAsync) return { error: "No listAsync" };

        try {
          const result = await threads.listAsync('SH_IMPORTANT', { offset: 0, limit: 3 });
          if (!result) return { result: null };

          if (Array.isArray(result)) {
            return {
              count: result.length,
              ids: result.map(t => {
                const meta = t?.metadata || t?._threadModel || t;
                return meta?.id;
              }),
            };
          }

          return {
            type: typeof result,
            keys: Object.keys(result).slice(0, 20),
          };
        } catch (e) {
          return { error: e.message, stack: e.stack?.slice(0, 200) };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("threads.listAsync result:", JSON.stringify(r5.result?.value, null, 2));

  // Wait to capture network
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 6. Try calling the backend directly to get threads with a list filter
  console.log("\n=== Trying backend.userdataGetThreads directly ===\n");
  const r6 = await uiClient.Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend) return { error: "No backend" };

        // Look for getThreads or similar methods
        const threadMethods = [];
        let obj = backend;
        while (obj && obj !== Object.prototype) {
          for (const key of Object.getOwnPropertyNames(obj)) {
            if (typeof obj[key] === 'function') {
              const kl = key.toLowerCase();
              if (kl.includes('thread') || kl.includes('list') || kl.includes('getlist')) {
                threadMethods.push(key);
              }
            }
          }
          obj = Object.getPrototypeOf(obj);
        }

        return { threadMethods };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r6.result?.value, null, 2));

  // 7. Check sync module — how does initial thread list get populated?
  console.log("\n=== sync module ===\n");
  const r7 = await uiClient.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const sync = ga?.sync;
        if (!sync) return { error: "No sync" };

        const keys = Object.keys(sync);
        const proto = Object.getPrototypeOf(sync);
        const protoKeys = proto ? Object.getOwnPropertyNames(proto).filter(k => k !== 'constructor') : [];

        // Filter for interesting methods
        const interesting = protoKeys.filter(m => {
          const ml = m.toLowerCase();
          return ml.includes('thread') || ml.includes('list') || ml.includes('inbox') ||
                 ml.includes('split') || ml.includes('classify') || ml.includes('fetch') ||
                 ml.includes('load') || ml.includes('sync') || ml.includes('initial');
        });

        return { keys: keys.slice(0, 30), interestingMethods: interesting, allProtoMethods: protoKeys };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r7.result?.value, null, 2));

  // 8. Navigate to inbox to trigger data loading
  console.log("\n=== Navigating to inbox to trigger network requests ===\n");
  await uiClient.Page.navigate({ url: "https://mail.superhuman.com/eddyhu@gmail.com" });
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Print summary of captured requests
  console.log("\n=== CAPTURED REQUESTS SUMMARY ===");
  console.log(`Total: ${capturedRequests.length}`);
  for (const req of capturedRequests) {
    console.log(`  ${req.method} ${req.url}`);
    if (req.body) console.log(`    Body: ${req.body.slice(0, 200)}`);
  }

  await bgClient.close();
  await uiClient.close();
}

main().catch(console.error);
