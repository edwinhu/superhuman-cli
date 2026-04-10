#!/usr/bin/env bun
/**
 * Explore Superhuman's split inbox internal state via CDP.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });

  // Find the main UI page
  const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page");
  const bgPage = targets.find(t => t.url.includes("background_page.html"));

  if (!mainPage) {
    console.error("No Superhuman UI page found");
    process.exit(1);
  }

  console.log(`Main page: ${mainPage.url}`);
  console.log(`Background page: ${bgPage?.url}`);

  // Connect to main page to explore UI state
  const client = await CDP({ port: CDP_PORT, target: mainPage.id });
  const { Runtime } = client;

  // 1. Explore URL routing — what inbox sections exist?
  console.log("\n=== URL / Router State ===");
  const routeResult = await Runtime.evaluate({
    expression: `
      (() => {
        return {
          currentUrl: window.location.href,
          pathname: window.location.pathname,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(routeResult.result?.value, null, 2));

  // 2. Explore GoogleAccount for split inbox sections
  console.log("\n=== GoogleAccount Keys ===");
  const gaResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        if (!ga) return { error: "No GoogleAccount" };
        return {
          topKeys: Object.keys(ga).slice(0, 50),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(gaResult.result?.value, null, 2));

  // 3. Deep dive into inbox-related properties
  console.log("\n=== Inbox / Split Related Properties ===");
  const inboxResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        if (!ga) return { error: "No GoogleAccount" };

        const info = {};

        // Search all top-level keys for inbox-related objects
        for (const key of Object.keys(ga)) {
          const lk = key.toLowerCase();
          if (lk.includes("inbox") || lk.includes("split") || lk.includes("screen") ||
              lk.includes("section") || lk.includes("bucket") || lk.includes("triage") ||
              lk.includes("category") || lk.includes("news") || lk.includes("feed") ||
              lk.includes("filter") || lk.includes("view") || lk.includes("tab")) {
            const val = ga[key];
            info["ga." + key] = {
              type: typeof val,
              keys: typeof val === 'object' && val !== null ? Object.keys(val).slice(0, 30) : undefined,
              value: typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' ? val : undefined,
            };
          }
        }

        // Check labels._settings._cache for split inbox settings
        if (ga.labels?._settings?._cache) {
          const cache = ga.labels._settings._cache;
          for (const key of Object.keys(cache)) {
            const lk = key.toLowerCase();
            if (lk.includes("split") || lk.includes("screen") || lk.includes("news") ||
                lk.includes("inbox") || lk.includes("bucket") || lk.includes("category") ||
                lk.includes("section") || lk.includes("tab") || lk.includes("triage") ||
                lk.includes("feed") || lk.includes("other") || lk.includes("important")) {
              info["settings." + key] = JSON.stringify(cache[key]).slice(0, 200);
            }
          }
        }

        return info;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(inboxResult.result?.value, null, 2));

  // 4. Look at the thread list / conversation controller
  console.log("\n=== Thread/Conversation Controller ===");
  const threadCtrlResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        if (!ga) return { error: "No GoogleAccount" };

        const info = {};

        // Look for threadList, conversationList, inboxItems, etc.
        for (const key of Object.keys(ga)) {
          const val = ga[key];
          if (typeof val !== 'object' || val === null) continue;

          const subKeys = Object.keys(val);
          // Check if this object has thread-like methods
          const hasThreadMethods = subKeys.some(k => {
            const lk = k.toLowerCase();
            return lk.includes("thread") || lk.includes("conversation") || lk.includes("list");
          });

          if (hasThreadMethods) {
            const threadMethods = subKeys.filter(k => {
              const lk = k.toLowerCase();
              return lk.includes("thread") || lk.includes("conversation") || lk.includes("list") ||
                     lk.includes("inbox") || lk.includes("section") || lk.includes("bucket");
            });
            if (threadMethods.length > 0) {
              info["ga." + key + "_threadMethods"] = threadMethods;
            }
          }
        }

        return info;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(threadCtrlResult.result?.value, null, 2));

  // 5. Look at ga.labels specifically
  console.log("\n=== ga.labels deep inspection ===");
  const labelsResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        if (!ga || !ga.labels) return { error: "No labels" };

        const labels = ga.labels;
        const info = {
          type: typeof labels,
          keys: Object.keys(labels).slice(0, 40),
        };

        // Look for methods
        const proto = Object.getPrototypeOf(labels);
        if (proto) {
          info.methods = Object.getOwnPropertyNames(proto).filter(k => typeof labels[k] === 'function').slice(0, 40);
        }

        // Check for settings cache keys
        if (labels._settings?._cache) {
          info.allSettingsKeys = Object.keys(labels._settings._cache);
        }

        // Check for label list
        if (labels._labels) {
          info.labelsType = typeof labels._labels;
          if (labels._labels instanceof Map) {
            info.labelCount = labels._labels.size;
            // Get first 5 labels
            const entries = [];
            let count = 0;
            for (const [id, label] of labels._labels) {
              if (count++ >= 10) break;
              entries.push({ id, keys: Object.keys(label).slice(0, 20), name: label.name || label.displayName });
            }
            info.sampleLabels = entries;
          } else if (Array.isArray(labels._labels)) {
            info.labelCount = labels._labels.length;
            info.sampleLabels = labels._labels.slice(0, 5).map(l => ({
              keys: Object.keys(l).slice(0, 20),
              name: l.name || l.displayName,
            }));
          }
        }

        return info;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(labelsResult.result?.value, null, 2));

  // 6. Explore the backend object methods more thoroughly
  console.log("\n=== Backend Methods ===");
  const backendResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        if (!ga || !ga.backend) return { error: "No backend" };

        const backend = ga.backend;
        const allMethods = Object.keys(backend).filter(k => typeof backend[k] === 'function');

        return {
          allMethods,
          // Group by possible categories
          inboxMethods: allMethods.filter(m => m.toLowerCase().includes("inbox")),
          threadMethods: allMethods.filter(m => m.toLowerCase().includes("thread")),
          listMethods: allMethods.filter(m => m.toLowerCase().includes("list")),
          getMethods: allMethods.filter(m => m.toLowerCase().includes("get")),
          syncMethods: allMethods.filter(m => m.toLowerCase().includes("sync")),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(backendResult.result?.value, null, 2));

  // 7. Look at the conversation/thread object structure
  console.log("\n=== First Inbox Thread Object ===");
  const threadObjResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        if (!ga) return { error: "No GoogleAccount" };

        // Try to find thread objects through various paths
        const info = {};

        // Try ga.threadListController or similar
        for (const key of Object.keys(ga)) {
          const val = ga[key];
          if (typeof val !== 'object' || val === null) continue;

          // Look for arrays that might be thread lists
          for (const subKey of Object.keys(val)) {
            const subVal = val[subKey];
            if (Array.isArray(subVal) && subVal.length > 0 && typeof subVal[0] === 'object') {
              const firstItem = subVal[0];
              const itemKeys = Object.keys(firstItem);
              // Check if this looks like a thread
              if (itemKeys.some(k => k === 'threadId' || k === 'id' || k === 'subject' || k === 'messages')) {
                info["ga." + key + "." + subKey] = {
                  length: subVal.length,
                  firstItemKeys: itemKeys.slice(0, 30),
                  // Dump some identifying fields
                  firstItemSample: {},
                };
                for (const ik of itemKeys) {
                  const v = firstItem[ik];
                  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                    info["ga." + key + "." + subKey].firstItemSample[ik] = v;
                  }
                }
              }
            }

            // Look for Maps
            if (subVal instanceof Map && subVal.size > 0) {
              const firstEntry = subVal.entries().next().value;
              if (firstEntry && typeof firstEntry[1] === 'object') {
                const entryKeys = Object.keys(firstEntry[1]);
                if (entryKeys.some(k => k === 'threadId' || k === 'id' || k === 'subject')) {
                  info["ga." + key + "." + subKey + " (Map)"] = {
                    size: subVal.size,
                    firstKey: firstEntry[0],
                    firstValueKeys: entryKeys.slice(0, 30),
                  };
                }
              }
            }
          }
        }

        return info;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(threadObjResult.result?.value, null, 2));

  await client.close();

  // Now connect to background page for API monitoring
  if (bgPage) {
    console.log("\n\n=== Background Page - Monitoring API Calls ===");
    const bgClient = await CDP({ port: CDP_PORT, target: bgPage.id });
    const { Network: BgNetwork, Runtime: BgRuntime } = bgClient;

    await BgNetwork.enable();

    // Check backend methods on background page too
    const bgBackend = await BgRuntime.evaluate({
      expression: `
        (() => {
          const ga = window.GoogleAccount;
          if (!ga || !ga.backend) return { error: "No backend on bg page" };

          const allMethods = Object.keys(ga.backend).filter(k => typeof ga.backend[k] === 'function');
          return {
            total: allMethods.length,
            all: allMethods.sort(),
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("\nBackground page backend methods:", JSON.stringify(bgBackend.result?.value, null, 2));

    // Try calling userdata.getThreads with different filter types
    console.log("\n=== Testing userdata.getThreads filter types ===");

    // Try filter: {} (no filter) to see what comes back
    const noFilterResult = await BgRuntime.evaluate({
      expression: `
        (async () => {
          const ga = window.GoogleAccount;
          if (!ga) return { error: "No GoogleAccount" };

          // Try the backend.getThreads if it exists
          if (ga.backend && typeof ga.backend.getThreads === 'function') {
            try {
              const result = await ga.backend.getThreads({ filter: {}, offset: 0, limit: 3 });
              return {
                method: "backend.getThreads",
                hasThreadList: !!result?.threadList,
                threadCount: result?.threadList?.length || 0,
                firstThread: result?.threadList?.[0] ? {
                  keys: Object.keys(result.threadList[0]),
                  threadKeys: result.threadList[0].thread ? Object.keys(result.threadList[0].thread) : undefined,
                } : undefined,
                topKeys: Object.keys(result || {}),
              };
            } catch (e) {
              return { error: "getThreads failed: " + e.message };
            }
          }

          return { error: "No getThreads method" };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("No filter:", JSON.stringify(noFilterResult.result?.value, null, 2));

    await bgClient.close();
  }
}

main().catch(console.error);
