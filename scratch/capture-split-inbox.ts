#!/usr/bin/env bun
/**
 * Capture Superhuman's split inbox API calls.
 *
 * Monitors network requests to find how Superhuman classifies
 * threads into Important vs Other buckets.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  // List all CDP targets
  const targets = await CDP.List({ port: CDP_PORT });
  console.log("Available targets:");
  for (const t of targets) {
    console.log(`  [${t.type}] ${t.title} — ${t.url}`);
  }

  // Find background page (where API calls happen)
  const bgPage = targets.find(t => t.url.includes("background_page.html"));
  if (!bgPage) {
    console.error("No background page found. Is Superhuman running with --remote-debugging-port=9400?");
    process.exit(1);
  }

  console.log(`\nConnecting to background page: ${bgPage.url}`);
  const client = await CDP({ port: CDP_PORT, target: bgPage.id });
  const { Network, Runtime } = client;

  // Enable network monitoring
  await Network.enable();

  const capturedPayloads: any[] = [];

  // Capture all requests to Superhuman backend
  Network.requestWillBeSent(({ requestId, request }) => {
    if (request.url.includes("/~backend/") || request.url.includes("userdata")) {
      const info: any = {
        url: request.url,
        method: request.method,
        timestamp: new Date().toISOString(),
      };
      if (request.postData) {
        try {
          info.postData = JSON.parse(request.postData);
        } catch {
          info.postData = request.postData;
        }
      }
      capturedPayloads.push(info);
      console.log(`\n>>> ${request.method} ${request.url}`);
      if (info.postData) {
        console.log("    Body:", JSON.stringify(info.postData, null, 2).slice(0, 500));
      }
    }
  });

  // Capture responses
  Network.responseReceived(async ({ requestId, response }) => {
    if (response.url.includes("/~backend/") || response.url.includes("userdata")) {
      try {
        const body = await Network.getResponseBody({ requestId });
        const parsed = JSON.parse(body.body);
        console.log(`\n<<< ${response.status} ${response.url}`);

        // Look for thread data with any classification fields
        const bodyStr = JSON.stringify(parsed);
        const interestingFields = [
          "bucket", "section", "importance", "splitInbox", "split_inbox",
          "category", "triage", "priority", "classification", "focused",
          "important", "other", "screeningStatus", "screening",
          "inbox_section", "inboxSection", "type", "filter"
        ];

        for (const field of interestingFields) {
          if (bodyStr.toLowerCase().includes(field.toLowerCase())) {
            console.log(`    *** Contains "${field}" ***`);
          }
        }

        // If it's a threadList response, dump the first thread's structure
        if (parsed.threadList && parsed.threadList.length > 0) {
          console.log("\n    === First thread structure ===");
          const firstThread = parsed.threadList[0];
          console.log(JSON.stringify(firstThread, null, 2).slice(0, 2000));
        }

        // Dump full response for small payloads
        if (bodyStr.length < 5000) {
          console.log("    Response:", JSON.stringify(parsed, null, 2));
        } else {
          console.log(`    Response size: ${bodyStr.length} bytes`);
          // Show top-level keys
          console.log("    Top-level keys:", Object.keys(parsed));
        }
      } catch (e) {
        // ignore
      }
    }
  });

  // Now let's also explore the internal state for split inbox info
  console.log("\n=== Exploring internal state ===\n");

  // Check GoogleAccount for split inbox / screening settings
  const stateResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        if (!ga) return { error: "No GoogleAccount" };

        const info = {};

        // Check labels/settings for split inbox config
        if (ga.labels?._settings?._cache) {
          const cache = ga.labels._settings._cache;
          const keys = Object.keys(cache);
          info.settingsKeys = keys;

          // Look for split inbox / screening related settings
          for (const key of keys) {
            const lk = key.toLowerCase();
            if (lk.includes("split") || lk.includes("screen") || lk.includes("bucket") ||
                lk.includes("import") || lk.includes("triage") || lk.includes("focus") ||
                lk.includes("inbox") || lk.includes("category") || lk.includes("section")) {
              info["setting_" + key] = cache[key];
            }
          }
        }

        // Check backend methods related to inbox
        if (ga.backend) {
          const methods = Object.keys(ga.backend).filter(k => typeof ga.backend[k] === 'function');
          const inboxMethods = methods.filter(m => {
            const ml = m.toLowerCase();
            return ml.includes("inbox") || ml.includes("split") || ml.includes("screen") ||
                   ml.includes("bucket") || ml.includes("import") || ml.includes("triage") ||
                   ml.includes("thread") || ml.includes("focus");
          });
          info.inboxRelatedMethods = inboxMethods;
          info.allBackendMethods = methods;
        }

        // Check for DI services related to split inbox
        if (ga.di || window.__di) {
          const di = ga.di || window.__di;
          const getNames = typeof di.getNames === 'function' ? di.getNames() : [];
          const splitNames = getNames.filter((n: string) => {
            const nl = n.toLowerCase();
            return nl.includes("split") || nl.includes("screen") || nl.includes("bucket") ||
                   nl.includes("triage") || nl.includes("inbox") || nl.includes("focus") ||
                   nl.includes("import");
          });
          info.splitInboxServices = splitNames;
        }

        return info;
      })()
    `,
    returnByValue: true,
  });

  console.log("Internal state:", JSON.stringify(stateResult.result?.value, null, 2));

  // Now try to explore thread objects in the internal cache
  const threadCacheResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        if (!ga) return { error: "No GoogleAccount" };

        // Try to find thread cache/store
        const info = {};

        // Check if there's a threads service
        if (ga.threads) {
          info.threadsKeys = Object.keys(ga.threads).slice(0, 30);
          info.threadsType = typeof ga.threads;

          // Look for cached threads
          if (ga.threads._cache) {
            const cacheKeys = Object.keys(ga.threads._cache).slice(0, 5);
            info.threadCacheKeys = cacheKeys;
            if (cacheKeys.length > 0) {
              const firstThread = ga.threads._cache[cacheKeys[0]];
              if (firstThread) {
                info.firstThreadKeys = Object.keys(firstThread);
                // Look for classification fields
                for (const key of Object.keys(firstThread)) {
                  const lk = key.toLowerCase();
                  if (lk.includes("split") || lk.includes("screen") || lk.includes("bucket") ||
                      lk.includes("import") || lk.includes("triage") || lk.includes("focus") ||
                      lk.includes("category") || lk.includes("section") || lk.includes("type") ||
                      lk.includes("class") || lk.includes("label") || lk.includes("priority")) {
                    info["thread_" + key] = firstThread[key];
                  }
                }
              }
            }
          }

          // Check for map/store
          if (ga.threads._threads) {
            info.threadsStoreType = typeof ga.threads._threads;
            if (ga.threads._threads instanceof Map) {
              info.threadsStoreSize = ga.threads._threads.size;
              const firstKey = ga.threads._threads.keys().next().value;
              if (firstKey) {
                const thread = ga.threads._threads.get(firstKey);
                info.firstStoreThreadKeys = Object.keys(thread).slice(0, 40);
              }
            }
          }
        }

        // Check inboxController or similar
        for (const key of Object.keys(ga)) {
          const lk = key.toLowerCase();
          if (lk.includes("inbox") || lk.includes("thread") || lk.includes("split") || lk.includes("screen")) {
            info["ga_" + key + "_type"] = typeof ga[key];
            if (typeof ga[key] === 'object' && ga[key] !== null) {
              info["ga_" + key + "_keys"] = Object.keys(ga[key]).slice(0, 20);
            }
          }
        }

        return info;
      })()
    `,
    returnByValue: true,
  });

  console.log("\nThread cache state:", JSON.stringify(threadCacheResult.result?.value, null, 2));

  // Explore DI container for screening/split inbox services
  const diResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        if (!ga) return { error: "No GoogleAccount" };

        // Try various DI access patterns
        const info = {};

        // Method 1: ga.di
        const di = ga.di || ga._di || ga.container;
        if (di) {
          info.diType = typeof di;
          info.diKeys = Object.keys(di).slice(0, 20);
        }

        // Method 2: Look for screening service on ga directly
        for (const key of Object.keys(ga)) {
          if (typeof ga[key] === 'object' && ga[key] !== null) {
            const subKeys = Object.keys(ga[key]);
            const hasScreening = subKeys.some(k =>
              k.toLowerCase().includes("screen") || k.toLowerCase().includes("split") ||
              k.toLowerCase().includes("bucket") || k.toLowerCase().includes("triage")
            );
            if (hasScreening) {
              info["found_in_" + key] = subKeys.filter(k => {
                const lk = k.toLowerCase();
                return lk.includes("screen") || lk.includes("split") || lk.includes("bucket") || lk.includes("triage");
              });
            }
          }
        }

        // Method 3: Check prototype chain of ga for screening
        const gaProto = Object.getPrototypeOf(ga);
        if (gaProto) {
          const protoMethods = Object.getOwnPropertyNames(gaProto);
          const screenMethods = protoMethods.filter(m => {
            const ml = m.toLowerCase();
            return ml.includes("screen") || ml.includes("split") || ml.includes("triage") ||
                   ml.includes("important") || ml.includes("bucket");
          });
          info.gaScreeningMethods = screenMethods;
        }

        return info;
      })()
    `,
    returnByValue: true,
  });

  console.log("\nDI/Screening state:", JSON.stringify(diResult.result?.value, null, 2));

  console.log("\n\n=== Monitoring for 30 seconds... Switch inbox views in Superhuman! ===\n");
  console.log("Try clicking 'Important' and 'Other' tabs in Superhuman's inbox\n");

  await new Promise(resolve => setTimeout(resolve, 30000));

  console.log("\n=== Capture complete ===");
  console.log(`Captured ${capturedPayloads.length} API calls`);

  await client.close();
}

main().catch(console.error);
