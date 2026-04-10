#!/usr/bin/env bun
/**
 * Deep dive into:
 * 1. backend.getThreads — what parameters does it accept?
 * 2. listRouter._splits — the split definitions
 * 3. listRouter.approximateGmailSearch — the Gmail query for each split
 * 4. backend.modifySplitInboxes — what does the modify call look like?
 * 5. backend.createImportanceOverride — override structure
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find(t =>
    t.url.includes("mail.superhuman.com") && t.type === "page" &&
    !t.url.includes("background_page") && !t.url.includes("tabs.html")
  );
  if (!mainPage) { console.error("No UI page"); process.exit(1); }

  const client = await CDP({ port: CDP_PORT, target: mainPage.id });

  // 1. listRouter._splits — the full split inbox configuration
  console.log("=== listRouter._splits ===\n");
  const r1 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr?._splits) return { error: "No _splits" };

        return lr._splits.map(s => {
          const result = {};
          for (const k of Object.keys(s)) {
            const v = s[k];
            if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              result[k] = v;
            } else if (Array.isArray(v)) {
              result[k] = v.length <= 20 ? v : '[Array(' + v.length + ')]';
            } else if (typeof v === 'function') {
              result[k] = '[fn]';
            } else {
              result[k] = '[obj: ' + Object.keys(v).slice(0, 10).join(',') + ']';
            }
          }
          return result;
        });
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r1.result?.value, null, 2));

  // 2. listRouter.approximateGmailSearch for each split
  console.log("\n=== approximateGmailSearch for splits ===\n");
  const r2 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr?.approximateGmailSearch) return { error: "No approximateGmailSearch" };

        const results = {};
        const splitIds = ['SH_IMPORTANT', 'SH_OTHER', 'INBOX'];
        for (const id of splitIds) {
          try {
            results[id] = lr.approximateGmailSearch(id);
          } catch (e) {
            results[id] = { error: e.message };
          }
        }
        return results;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r2.result?.value, null, 2));

  // 3. getMicrosoftSearchQueryForSplit
  console.log("\n=== getMicrosoftSearchQueryForSplit ===\n");
  const r3 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr?.getMicrosoftSearchQueryForSplit) return { error: "No method" };

        const results = {};
        const splitIds = ['SH_IMPORTANT', 'SH_OTHER'];
        for (const id of splitIds) {
          try {
            results[id] = lr.getMicrosoftSearchQueryForSplit(id);
          } catch (e) {
            results[id] = { error: e.message };
          }
        }
        return results;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r3.result?.value, null, 2));

  // 4. getImportantDefinition
  console.log("\n=== getImportantDefinition ===\n");
  const r4 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr?.getImportantDefinition) return { error: "No method" };

        try {
          const def = lr.getImportantDefinition();
          if (!def) return { result: null };

          // Serialize safely
          const result = {};
          for (const k of Object.keys(def)) {
            const v = def[k];
            if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              result[k] = v;
            } else if (Array.isArray(v)) {
              result[k] = v;
            } else if (typeof v === 'function') {
              result[k] = '[fn]';
            } else {
              result[k] = '[obj: ' + Object.keys(v).slice(0, 10).join(',') + ']';
            }
          }
          return result;
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r4.result?.value, null, 2));

  // 5. backend.getThreads — inspect the function source
  console.log("\n=== backend.getThreads source ===\n");
  const r5 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend?.getThreads) return { error: "No getThreads" };

        return backend.getThreads.toString().slice(0, 1000);
      })()
    `,
    returnByValue: true,
  });
  console.log(r5.result?.value);

  // 6. backend.modifySplitInboxes — function source
  console.log("\n=== backend.modifySplitInboxes source ===\n");
  const r6 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend?.modifySplitInboxes) return { error: "No method" };

        return backend.modifySplitInboxes.toString().slice(0, 1000);
      })()
    `,
    returnByValue: true,
  });
  console.log(r6.result?.value);

  // 7. backend.createImportanceOverride — function source
  console.log("\n=== backend.createImportanceOverride source ===\n");
  const r7 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend?.createImportanceOverride) return { error: "No method" };

        return backend.createImportanceOverride.toString().slice(0, 1000);
      })()
    `,
    returnByValue: true,
  });
  console.log(r7.result?.value);

  // 8. backend.syntheticInbox — might be relevant
  console.log("\n=== backend.syntheticInbox source ===\n");
  const r8 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend?.syntheticInbox) return { error: "No method" };

        return backend.syntheticInbox.toString().slice(0, 1000);
      })()
    `,
    returnByValue: true,
  });
  console.log(r8.result?.value);

  // 9. Check the fromMeFilter on listRouter
  console.log("\n=== listRouter.fromMeFilter ===\n");
  const r9 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr?.fromMeFilter) return { error: "No method" };

        return lr.fromMeFilter.toString().slice(0, 500);
      })()
    `,
    returnByValue: true,
  });
  console.log(r9.result?.value);

  // 10. Try backend.getThreads with listId filter and capture what happens
  console.log("\n=== Calling backend.getThreads({filter: {listId: 'SH_IMPORTANT'}}) ===\n");

  // Monitor network on background page
  const bgPage = targets.find(t => t.url.includes("background_page"));
  let bgClient: any = null;
  if (bgPage) {
    bgClient = await CDP({ port: CDP_PORT, target: bgPage.id });
    await bgClient.Network.enable();
    bgClient.Network.requestWillBeSent((params: any) => {
      const url = params.request.url;
      if (url.includes("metrics") || url.match(/\.(js|css|png|svg)/)) return;
      console.log(`  [NET] ${params.request.method} ${url.slice(0, 120)}`);
      if (params.request.postData) {
        console.log(`  Body: ${params.request.postData.slice(0, 300)}`);
      }
    });
  }

  // Also monitor UI network
  client.Network.requestWillBeSent((params: any) => {
    const url = params.request.url;
    if (url.includes("metrics") || url.match(/\.(js|css|png|svg|woff|otf)/)) return;
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    console.log(`  [UI-NET] ${params.request.method} ${url.slice(0, 120)}`);
    if (params.request.postData) {
      console.log(`  Body: ${params.request.postData.slice(0, 300)}`);
    }
  });
  await client.Network.enable();

  const r10 = await client.Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend?.getThreads) return { error: "No getThreads" };

        try {
          const result = await backend.getThreads({ filter: { listId: "SH_IMPORTANT" }, offset: 0, limit: 3 });
          if (!result) return { result: null };

          if (result.threadList) {
            return {
              threadListLength: result.threadList.length,
              keys: Object.keys(result),
              firstThread: result.threadList[0] ? Object.keys(result.threadList[0]).slice(0, 15) : null,
            };
          }
          return { keys: Object.keys(result).slice(0, 20) };
        } catch (e) {
          return { error: e.message, stack: e.stack?.slice(0, 300) };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("getThreads result:", JSON.stringify(r10.result?.value, null, 2));

  await new Promise(resolve => setTimeout(resolve, 2000));

  await client.close();
  if (bgClient) await bgClient.close();
}

main().catch(console.error);
