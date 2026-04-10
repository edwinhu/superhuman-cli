#!/usr/bin/env bun
/**
 * Test threads.listAsync via CDP to list Important/Other threads.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No UI page"); process.exit(1); }

  const client = await CDP({ port: CDP_PORT, target: mainPage.id });
  const { Runtime } = client;

  // 1. Try threads.listAsync with correct args
  console.log("=== threads.listAsync('SH_IMPORTANT', {offset:0, limit:5}) ===");
  const result1 = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const threads = ga.threads;

        try {
          const result = await threads.listAsync('SH_IMPORTANT', {offset: 0, limit: 5});
          if (!result) return { result: null };

          // Result is likely an array of thread presenters
          if (Array.isArray(result)) {
            return result.map(t => {
              const meta = t?.metadata || t?._threadModel || t;
              return {
                id: meta?.id || t?.id,
                subject: meta?.subject?.slice(0, 80),
                listIds: meta?._listIds || meta?.listIds?.(),
              };
            });
          }

          return {
            type: typeof result,
            keys: Object.keys(result).slice(0, 20),
          };
        } catch (e) {
          return { error: e.message, stack: e.stack?.slice(0, 300) };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(result1.result?.value, null, 2));

  // 2. Alternative: use disk.thread.listAsync
  console.log("\n=== disk.thread.listAsync ===");
  const result2 = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const diskThread = ga.disk?.thread;
        if (!diskThread) return { error: "No disk.thread" };

        try {
          // Try listing threads for SH_IMPORTANT
          const result = await diskThread.listAsync('SH_IMPORTANT', { offset: 0, limit: 5 });
          if (!result) return { result: null };

          if (Array.isArray(result)) {
            return {
              count: result.length,
              first: result[0] ? Object.keys(result[0]).slice(0, 20) : null,
            };
          }

          return { type: typeof result, keys: Object.keys(result).slice(0, 20) };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(result2.result?.value, null, 2));

  // 3. Alternative: get all threads from identityMap and filter by _listIds
  console.log("\n=== Identity Map: threads with SH_IMPORTANT ===");
  const result3 = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const importantThreads = [];
        const otherThreads = [];
        const inboxThreads = [];

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta) continue;

          const listIds = meta._listIds || [];

          if (listIds.includes('SH_IMPORTANT') && listIds.includes('INBOX')) {
            importantThreads.push({
              id: meta.id,
              subject: meta.subject?.slice(0, 60),
              listIds,
            });
          }

          if (listIds.includes('SH_OTHER') && listIds.includes('INBOX')) {
            otherThreads.push({
              id: meta.id,
              subject: meta.subject?.slice(0, 60),
            });
          }

          if (listIds.includes('INBOX')) {
            inboxThreads.push(meta.id);
          }
        }

        return {
          totalCached: Object.keys(tree.cache).length,
          inboxCount: inboxThreads.length,
          importantCount: importantThreads.length,
          otherCount: otherThreads.length,
          importantSample: importantThreads.slice(0, 5),
          otherSample: otherThreads.slice(0, 5),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(result3.result?.value, null, 2));

  // 4. Check on UVA account - switch to it first
  console.log("\n=== Checking if UVA account has its own identityMap ===");
  const result4 = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        // Check accountList for UVA
        if (ga.accountList) {
          return {
            accounts: ga.accountList.map(a => ({
              email: a?.user?.emailAddress || a?.email,
              hasThreads: !!a?.threads,
              hasIdentityMap: !!a?.threads?.identityMap,
            })),
          };
        }
        return { error: "No accountList" };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(result4.result?.value, null, 2));

  // 5. Try to access UVA account threads
  console.log("\n=== UVA Account Threads ===");
  const result5 = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        if (!ga.accountList) return { error: "No accountList" };

        const uva = ga.accountList.find(a =>
          (a?.user?.emailAddress || a?.email || '').includes('virginia.edu')
        );
        if (!uva) return { error: "UVA account not found in accountList" };

        const tree = uva.threads?.identityMap;
        if (!tree?.cache) return { error: "No UVA threads cache" };

        const importantThreads = [];
        const otherThreads = [];

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta) continue;

          const listIds = meta._listIds || [];

          if (listIds.includes('SH_IMPORTANT') && listIds.includes('INBOX')) {
            importantThreads.push({
              id: meta.id,
              subject: meta.subject?.slice(0, 60),
              from: meta.contacts?.[0]?.email || meta.emails?.[0],
            });
          }

          if (listIds.includes('SH_OTHER') && listIds.includes('INBOX')) {
            otherThreads.push({
              id: meta.id,
              subject: meta.subject?.slice(0, 60),
            });
          }
        }

        return {
          totalCached: Object.keys(tree.cache).length,
          importantCount: importantThreads.length,
          otherCount: otherThreads.length,
          importantSample: importantThreads.slice(0, 5),
          otherSample: otherThreads.slice(0, 3),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(result5.result?.value, null, 2));

  await client.close();
}

main().catch(console.error);
