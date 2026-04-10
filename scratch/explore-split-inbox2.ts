#!/usr/bin/env bun
/**
 * Explore Superhuman split inbox: thread objects, list router, and splits.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman UI page found"); process.exit(1); }

  const client = await CDP({ port: CDP_PORT, target: mainPage.id });
  const { Runtime } = client;

  // 1. Get full splitInboxes setting
  console.log("=== splitInboxes setting ===");
  const splitResult = await Runtime.evaluate({
    expression: `JSON.stringify(window.GoogleAccount.labels._settings._cache.splitInboxes)`,
    returnByValue: true,
  });
  console.log(JSON.parse(splitResult.result?.value || "null"));

  // 2. Get all SH_ labels
  console.log("\n=== Superhuman Labels ===");
  const labelsResult = await Runtime.evaluate({
    expression: `
      (() => {
        const labels = window.GoogleAccount.labels;
        return {
          SH_IMPORTANT: labels.SH_IMPORTANT,
          SH_OTHER: labels.SH_OTHER,
          SH_ALL: labels.SH_ALL,
          allSH: labels.list.filter(l => l.id.startsWith("SH_") || l.type === "superhuman").map(l => ({
            id: l.id, slug: l.slug, name: l.name, type: l.type
          })),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(labelsResult.result?.value, null, 2));

  // 3. List router splits
  console.log("\n=== List Router ===");
  const routerResult = await Runtime.evaluate({
    expression: `
      (() => {
        const lr = window.GoogleAccount.listRouter;
        if (!lr) return { error: "No listRouter" };

        return {
          keys: Object.keys(lr),
          splits: lr._splits?.map(s => ({
            id: s.id,
            type: s.type,
            isDisabled: s.isDisabled,
            matcherName: s.matcher?.name,
            matcherQuery: s.matcher?.query,
            labels: s.labels,
            query: s.query,
            leaveThreadsInImportantOther: s.leaveThreadsInImportantOther,
          })),
          listIds: lr._listIds,
          methods: Object.getOwnPropertyNames(Object.getPrototypeOf(lr)).filter(k => typeof lr[k] === 'function'),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(routerResult.result?.value, null, 2));

  // 4. Explore thread objects to find which label/section they belong to
  console.log("\n=== Thread Objects (from ga.threads) ===");
  const threadsResult = await Runtime.evaluate({
    expression: `
      (() => {
        const threads = window.GoogleAccount.threads;
        if (!threads) return { error: "No threads" };

        const info = {
          keys: Object.keys(threads).slice(0, 30),
          type: typeof threads,
        };

        // Check _threads map/store
        if (threads._threads) {
          info._threadsType = typeof threads._threads;
          if (threads._threads instanceof Map) {
            info._threadsSize = threads._threads.size;
          }
        }

        // Look for getThread method
        const proto = Object.getPrototypeOf(threads);
        if (proto) {
          info.methods = Object.getOwnPropertyNames(proto).filter(k => typeof threads[k] === 'function');
        }

        return info;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(threadsResult.result?.value, null, 2));

  // 5. Get a real thread object and dump its full structure
  console.log("\n=== Sample Thread Object ===");
  const sampleResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;

        // Try to get threads from the disk cache or threads store
        const threads = ga.threads;
        if (!threads) return { error: "No threads service" };

        // Try _threads Map
        if (threads._threads instanceof Map && threads._threads.size > 0) {
          const [id, thread] = threads._threads.entries().next().value;
          const allKeys = Object.keys(thread);
          const sample = {};
          for (const k of allKeys) {
            const v = thread[k];
            if (v === null || v === undefined) {
              sample[k] = v;
            } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              sample[k] = typeof v === 'string' && v.length > 100 ? v.slice(0, 100) + '...' : v;
            } else if (Array.isArray(v)) {
              sample[k] = '[Array(' + v.length + ')]';
            } else if (typeof v === 'object') {
              sample[k] = '{' + Object.keys(v).join(',') + '}';
            } else {
              sample[k] = typeof v;
            }
          }
          return { id, allKeys, sample };
        }

        // Try get method
        if (typeof threads.get === 'function') {
          return { hasGet: true };
        }

        return { error: "Cannot access threads" };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(sampleResult.result?.value, null, 2));

  // 6. Try to get thread from disk cache
  console.log("\n=== Disk Cache Thread ===");
  const diskResult = await Runtime.evaluate({
    expression: `
      (() => {
        const disk = window.GoogleAccount.disk;
        if (!disk) return { error: "No disk" };

        const info = {
          keys: Object.keys(disk).slice(0, 30),
          methods: Object.getOwnPropertyNames(Object.getPrototypeOf(disk)).filter(k => typeof disk[k] === 'function'),
        };

        // Try disk.thread or disk._cache
        if (disk.thread) {
          info.threadType = typeof disk.thread;
          if (typeof disk.thread === 'object') {
            info.threadKeys = Object.keys(disk.thread).slice(0, 20);
          }
        }

        return info;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(diskResult.result?.value, null, 2));

  // 7. Explore listCounts to find inbox list IDs
  console.log("\n=== List Counts (inbox sections) ===");
  const countsResult = await Runtime.evaluate({
    expression: `
      (() => {
        const lc = window.GoogleAccount.listCounts;
        if (!lc) return { error: "No listCounts" };

        const info = {
          keys: Object.keys(lc).slice(0, 30),
        };

        // Look for counts data
        if (lc._counts) {
          if (lc._counts instanceof Map) {
            info.countsEntries = Array.from(lc._counts.entries()).slice(0, 20);
          } else {
            info.countsData = lc._counts;
          }
        }

        return info;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(countsResult.result?.value, null, 2));

  // 8. Explore the cacheList function to find inbox list loading
  console.log("\n=== cacheList / preloadImportantThreadLists ===");
  const cacheResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;

        // Check cacheList args
        const cacheList = ga.cacheList;
        const preload = ga.preloadImportantThreadLists;

        return {
          cacheListType: typeof cacheList,
          preloadType: typeof preload,
          cacheListStr: cacheList?.toString?.()?.slice(0, 300),
          preloadStr: preload?.toString?.()?.slice(0, 500),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(cacheResult.result?.value, null, 2));

  // 9. What's in the "monitor" — does it track thread-to-list mappings?
  console.log("\n=== Monitor (thread tracking) ===");
  const monitorResult = await Runtime.evaluate({
    expression: `
      (() => {
        const monitor = window.GoogleAccount.monitor;
        if (!monitor) return { error: "No monitor" };

        const info = {
          keys: Object.keys(monitor).slice(0, 30),
          methods: Object.getOwnPropertyNames(Object.getPrototypeOf(monitor)).filter(k => typeof monitor[k] === 'function'),
        };

        // Check _threads
        if (monitor._threads instanceof Map) {
          info.threadsSize = monitor._threads.size;
          if (monitor._threads.size > 0) {
            const [id, thread] = monitor._threads.entries().next().value;
            info.firstThread = {
              id,
              keys: Object.keys(thread).slice(0, 30),
            };
            // Dump all string/number/boolean fields
            const sample = {};
            for (const k of Object.keys(thread)) {
              const v = thread[k];
              if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                sample[k] = v;
              }
            }
            info.firstThreadSample = sample;
          }
        }

        return info;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(monitorResult.result?.value, null, 2));

  // 10. Try to get threads from inbox list directly via the portal
  console.log("\n=== Portal thread listing ===");
  const portalResult = await Runtime.evaluate({
    expression: `
      (() => {
        const portal = window.GoogleAccount.portal;
        if (!portal) return { error: "No portal" };

        return {
          keys: Object.keys(portal).slice(0, 30),
          methods: Object.getOwnPropertyNames(Object.getPrototypeOf(portal)).filter(k => typeof portal[k] === 'function'),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(portalResult.result?.value, null, 2));

  await client.close();
}

main().catch(console.error);
