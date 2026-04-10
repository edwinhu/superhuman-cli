#!/usr/bin/env bun
/**
 * Explore thread list IDs, call userdata.getThreads, and inspect thread objects
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No UI page"); process.exit(1); }

  const client = await CDP({ port: CDP_PORT, target: mainPage.id });
  const { Runtime } = client;

  // 1. Get listRouter._listIds (these are the inbox section IDs)
  console.log("=== listRouter._listIds ===");
  const listIdsResult = await Runtime.evaluate({
    expression: `JSON.stringify(window.GoogleAccount.listRouter._listIds)`,
    returnByValue: true,
  });
  console.log(JSON.parse(listIdsResult.result?.value || "null"));

  // 2. Get listCounts._countsById
  console.log("\n=== listCounts._countsById ===");
  const countsResult = await Runtime.evaluate({
    expression: `
      (() => {
        const lc = window.GoogleAccount.listCounts;
        if (!lc || !lc._countsById) return null;
        if (lc._countsById instanceof Map) {
          return Object.fromEntries(lc._countsById);
        }
        return lc._countsById;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(countsResult.result?.value, null, 2));

  // 3. Call threads.listAsync with the important/other IDs
  console.log("\n=== threads.listAsync with SH_IMPORTANT ===");
  const importantResult = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const threads = ga.threads;
        if (!threads || typeof threads.listAsync !== 'function') {
          return { error: "No listAsync" };
        }

        try {
          // Try calling listAsync with listId = 'SH_IMPORTANT'
          const result = await threads.listAsync('SH_IMPORTANT', { offset: 0, limit: 3 });
          if (!result) return { result: null };

          return {
            type: typeof result,
            keys: Object.keys(result).slice(0, 20),
            length: Array.isArray(result) ? result.length : result.threads?.length,
            // If array, dump first item
            firstItem: Array.isArray(result) && result.length > 0 ? {
              keys: Object.keys(result[0]).slice(0, 30),
              sample: (() => {
                const s = {};
                for (const k of Object.keys(result[0])) {
                  const v = result[0][k];
                  if (typeof v === 'string') s[k] = v.slice(0, 100);
                  else if (typeof v === 'number' || typeof v === 'boolean') s[k] = v;
                  else if (Array.isArray(v)) s[k] = '[Array(' + v.length + ')]';
                  else if (v === null) s[k] = null;
                  else s[k] = typeof v;
                }
                return s;
              })(),
            } : undefined,
          };
        } catch (e) {
          return { error: e.message, stack: e.stack?.slice(0, 200) };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(importantResult.result?.value, null, 2));

  // 4. Try to get a thread presenter to see full thread structure
  console.log("\n=== Thread Presenter (first thread) ===");
  const presenterResult = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const threads = ga.threads;

        // Get the identity map
        if (threads.identityMap) {
          const idMap = threads.identityMap;
          const info = {
            type: typeof idMap,
            keys: Object.keys(idMap).slice(0, 20),
          };

          if (idMap instanceof Map) {
            info.size = idMap.size;
            if (idMap.size > 0) {
              const [id, presenter] = idMap.entries().next().value;
              info.firstId = id;
              if (presenter) {
                info.presenterKeys = Object.keys(presenter).slice(0, 40);
                // Look for list/section info
                const sample = {};
                for (const k of Object.keys(presenter)) {
                  const v = presenter[k];
                  if (typeof v === 'string') sample[k] = v.slice(0, 100);
                  else if (typeof v === 'number' || typeof v === 'boolean') sample[k] = v;
                  else if (Array.isArray(v)) {
                    sample[k] = '[Array(' + v.length + ')]';
                    if (v.length > 0 && v.length <= 5 && (typeof v[0] === 'string' || typeof v[0] === 'number')) {
                      sample[k + '_values'] = v;
                    }
                  }
                  else if (v === null || v === undefined) sample[k] = v;
                  else sample[k] = '{' + Object.keys(v).slice(0, 10).join(',') + '}';
                }
                info.presenterSample = sample;
              }
            }
          } else if (typeof idMap === 'object') {
            const keys = Object.keys(idMap);
            info.size = keys.length;
            if (keys.length > 0) {
              const firstKey = keys[0];
              const presenter = idMap[firstKey];
              info.firstKey = firstKey;
              if (presenter) {
                info.presenterKeys = Object.keys(presenter).slice(0, 40);
              }
            }
          }

          return info;
        }

        return { error: "No identityMap" };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(presenterResult.result?.value, null, 2));

  // 5. Specifically look for listIds on a thread presenter
  console.log("\n=== Thread Presenter ListIds ===");
  const threadListIdResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const threads = ga.threads;

        if (!threads.identityMap) return { error: "No identityMap" };

        const results = [];
        let count = 0;

        const entries = threads.identityMap instanceof Map
          ? threads.identityMap.entries()
          : Object.entries(threads.identityMap);

        for (const [id, presenter] of entries) {
          if (count++ >= 5) break;
          const entry = { id };

          // Check all properties that might indicate inbox section
          for (const k of Object.keys(presenter)) {
            const lk = k.toLowerCase();
            if (lk.includes("list") || lk.includes("label") || lk.includes("section") ||
                lk.includes("bucket") || lk.includes("split") || lk.includes("important") ||
                lk.includes("other") || lk.includes("category") || lk.includes("type") ||
                lk.includes("inbox") || lk.includes("route") || lk.includes("screen")) {
              const v = presenter[k];
              if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
                entry[k] = v;
              } else if (Array.isArray(v)) {
                entry[k] = v.length <= 10 ? v : '[Array(' + v.length + ')]';
              } else if (v instanceof Set) {
                entry[k] = Array.from(v);
              } else if (typeof v === 'object') {
                entry[k] = '{' + Object.keys(v).slice(0, 10).join(',') + '}';
              }
            }
          }

          results.push(entry);
        }

        return results;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(threadListIdResult.result?.value, null, 2));

  // 6. Try using portal.invoke to call threads.listAsync
  console.log("\n=== Portal invoke for listing threads ===");
  const portalInvokeResult = await Runtime.evaluate({
    expression: `
      (async () => {
        const portal = window.GoogleAccount.portal;
        if (!portal) return { error: "No portal" };

        try {
          // Try to list threads via portal - this is how the app fetches inbox lists
          const result = await portal.invoke('threads.listAsync', ['SH_IMPORTANT', { offset: 0, limit: 3 }]);
          if (!result) return { result: null };

          return {
            type: typeof result,
            keys: result ? Object.keys(result).slice(0, 20) : [],
            isArray: Array.isArray(result),
            length: Array.isArray(result) ? result.length : undefined,
            firstItem: Array.isArray(result) && result.length > 0 ? Object.keys(result[0]).slice(0, 30) : undefined,
          };
        } catch (e) {
          return { error: "invoke failed: " + e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(portalInvokeResult.result?.value, null, 2));

  // 7. Check the disk.list for cached thread lists
  console.log("\n=== disk.list (cached lists) ===");
  const diskListResult = await Runtime.evaluate({
    expression: `
      (async () => {
        const disk = window.GoogleAccount.disk;
        if (!disk || !disk.list) return { error: "No disk.list" };

        const list = disk.list;
        const info = {
          type: typeof list,
          keys: Object.keys(list).slice(0, 30),
          methods: Object.getOwnPropertyNames(Object.getPrototypeOf(list)).filter(k => typeof list[k] === 'function'),
        };

        // Try getAsync for SH_IMPORTANT
        if (typeof list.getAsync === 'function') {
          try {
            const result = await list.getAsync('SH_IMPORTANT');
            if (result) {
              info.importantResult = {
                type: typeof result,
                keys: Object.keys(result).slice(0, 20),
                threadIds: result.threadIds?.slice(0, 5),
                length: result.threadIds?.length,
              };
            }
          } catch (e) {
            info.importantError = e.message;
          }
        }

        // Try get for SH_OTHER
        if (typeof list.getAsync === 'function') {
          try {
            const result = await list.getAsync('SH_OTHER');
            if (result) {
              info.otherResult = {
                type: typeof result,
                keys: Object.keys(result).slice(0, 20),
                threadIds: result.threadIds?.slice(0, 5),
                length: result.threadIds?.length,
              };
            }
          } catch (e) {
            info.otherError = e.message;
          }
        }

        return info;
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(diskListResult.result?.value, null, 2));

  await client.close();
}

main().catch(console.error);
