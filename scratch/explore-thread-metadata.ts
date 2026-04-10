#!/usr/bin/env bun
/**
 * Deep inspect thread metadata and superhumanData for split inbox fields.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No UI page"); process.exit(1); }

  const client = await CDP({ port: CDP_PORT, target: mainPage.id });
  const { Runtime } = client;

  // 1. Dump full metadata of first cached thread
  console.log("=== Thread Metadata ===");
  const metaResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const threadIds = Object.keys(tree.cache);
        const results = [];

        for (let i = 0; i < Math.min(3, threadIds.length); i++) {
          const id = threadIds[i];
          const presenter = tree.cache[id];
          const meta = presenter?.metadata || presenter?._threadModel;

          if (!meta) continue;

          const entry = { threadId: id, metaKeys: Object.keys(meta) };

          // Dump metadata fields
          const dump = {};
          for (const k of Object.keys(meta)) {
            const v = meta[k];
            if (v === null || v === undefined) dump[k] = v;
            else if (typeof v === 'string') dump[k] = v.slice(0, 200);
            else if (typeof v === 'number' || typeof v === 'boolean') dump[k] = v;
            else if (Array.isArray(v)) {
              if (v.length <= 10 && v.every(x => typeof x === 'string' || typeof x === 'number')) {
                dump[k] = v;
              } else if (k === 'messages') {
                dump[k] = '[Messages(' + v.length + ')]';
              } else {
                dump[k] = '[Array(' + v.length + ')]';
              }
            }
            else if (typeof v === 'object') {
              const subKeys = Object.keys(v);
              if (subKeys.length <= 15) {
                const sub = {};
                for (const sk of subKeys) {
                  const sv = v[sk];
                  if (typeof sv === 'string') sub[sk] = sv.slice(0, 150);
                  else if (typeof sv === 'number' || typeof sv === 'boolean' || sv === null) sub[sk] = sv;
                  else if (Array.isArray(sv)) {
                    if (sv.length <= 10 && sv.every(x => typeof x === 'string' || typeof x === 'number')) {
                      sub[sk] = sv;
                    } else {
                      sub[sk] = '[Array(' + sv.length + ')]';
                    }
                  }
                  else sub[sk] = typeof sv;
                }
                dump[k] = sub;
              } else {
                dump[k] = '{keys: ' + subKeys.length + ', first10: [' + subKeys.slice(0, 10).join(',') + ']}';
              }
            }
          }
          entry.dump = dump;
          results.push(entry);
        }

        return results;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(metaResult.result?.value, null, 2));

  // 2. Look specifically at superhumanData
  console.log("\n\n=== superhumanData on multiple threads ===");
  const shDataResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const threadIds = Object.keys(tree.cache);
        const results = [];

        for (let i = 0; i < Math.min(10, threadIds.length); i++) {
          const id = threadIds[i];
          const presenter = tree.cache[id];
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?.superhumanData) continue;

          const shd = meta.superhumanData;
          const entry = { threadId: id, subject: meta.subject?.slice(0, 80) };

          // Dump all superhumanData fields
          for (const k of Object.keys(shd)) {
            const v = shd[k];
            if (v === null || v === undefined) entry[k] = v;
            else if (typeof v === 'string') entry[k] = v.slice(0, 200);
            else if (typeof v === 'number' || typeof v === 'boolean') entry[k] = v;
            else if (Array.isArray(v)) {
              if (v.length <= 10) entry[k] = v;
              else entry[k] = '[Array(' + v.length + ')]';
            }
            else if (typeof v === 'object') {
              const subKeys = Object.keys(v);
              const sub = {};
              for (const sk of subKeys) {
                const sv = v[sk];
                if (typeof sv === 'string') sub[sk] = sv.slice(0, 100);
                else if (typeof sv === 'number' || typeof sv === 'boolean' || sv === null) sub[sk] = sv;
                else sub[sk] = typeof sv;
              }
              entry[k] = sub;
            }
          }

          results.push(entry);
        }

        return results;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(shDataResult.result?.value, null, 2));

  // 3. Check listIds on threads via the disk cache
  console.log("\n\n=== Thread listIds from disk ===");
  const diskThreadResult = await Runtime.evaluate({
    expression: `
      (async () => {
        const disk = window.GoogleAccount.disk;
        if (!disk?.thread) return { error: "No disk.thread" };

        const threadDisk = disk.thread;
        const info = {
          type: typeof threadDisk,
          keys: Object.keys(threadDisk).slice(0, 20),
          methods: Object.getOwnPropertyNames(Object.getPrototypeOf(threadDisk)).filter(k => typeof threadDisk[k] === 'function'),
        };

        // Try to get a thread from disk
        if (typeof threadDisk.getAsync === 'function') {
          // Get a thread ID from the identity map
          const tree = window.GoogleAccount.threads?.identityMap;
          const threadIds = tree?.cache ? Object.keys(tree.cache) : [];
          if (threadIds.length > 0) {
            try {
              const diskThread = await threadDisk.getAsync(threadIds[0]);
              if (diskThread) {
                info.diskThreadKeys = Object.keys(diskThread);
                // Dump the thread
                const dump = {};
                for (const k of Object.keys(diskThread)) {
                  const v = diskThread[k];
                  if (v === null || v === undefined) dump[k] = v;
                  else if (typeof v === 'string') dump[k] = v.slice(0, 200);
                  else if (typeof v === 'number' || typeof v === 'boolean') dump[k] = v;
                  else if (Array.isArray(v)) {
                    if (v.length <= 10 && v.every(x => typeof x === 'string')) dump[k] = v;
                    else dump[k] = '[Array(' + v.length + ')]';
                  }
                  else if (typeof v === 'object') {
                    dump[k] = '{' + Object.keys(v).slice(0, 10).join(',') + '}';
                  }
                }
                info.diskThreadDump = dump;
              }
            } catch (e) {
              info.getError = e.message;
            }
          }
        }

        return info;
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(diskThreadResult.result?.value, null, 2));

  // 4. Check the actual thread model methods for list membership
  console.log("\n\n=== Thread Model Methods ===");
  const modelResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const threadIds = Object.keys(tree.cache);
        const presenter = tree.cache[threadIds[0]];
        const meta = presenter?.metadata || presenter?._threadModel;
        if (!meta) return { error: "No metadata" };

        // Get prototype methods
        const proto = Object.getPrototypeOf(meta);
        const methods = proto ? Object.getOwnPropertyNames(proto).filter(k => typeof meta[k] === 'function') : [];

        // Find methods related to lists/sections/importance
        const relevantMethods = methods.filter(m => {
          const ml = m.toLowerCase();
          return ml.includes("list") || ml.includes("label") || ml.includes("section") ||
                 ml.includes("bucket") || ml.includes("split") || ml.includes("import") ||
                 ml.includes("other") || ml.includes("route") || ml.includes("screen") ||
                 ml.includes("inbox") || ml.includes("category") || ml.includes("type") ||
                 ml.includes("is") || ml.includes("get");
        });

        return {
          allMethods: methods,
          relevantMethods,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(modelResult.result?.value, null, 2));

  // 5. Call relevant getter methods on threads
  console.log("\n\n=== Calling Thread Methods ===");
  const callResult = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const threadIds = Object.keys(tree.cache).slice(0, 5);
        const results = [];

        for (const id of threadIds) {
          const presenter = tree.cache[id];
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta) continue;

          const entry = { id, subject: meta.subject?.slice(0, 60) };

          // Try various property getters/methods
          const tryProps = [
            'listIds', 'labelIds', 'labels', 'section', 'bucket',
            'splitInbox', 'splitInboxId', 'importance', 'isImportant',
            'isOther', 'category', 'inboxSection', 'screeningStatus',
            'routeId', 'listId', 'type', 'threadType',
          ];

          for (const prop of tryProps) {
            try {
              let val;
              if (typeof meta[prop] === 'function') {
                val = meta[prop]();
              } else {
                val = meta[prop];
              }
              if (val !== undefined) {
                if (typeof val === 'object' && val !== null) {
                  if (Array.isArray(val)) entry[prop] = val.length <= 20 ? val : '[Array(' + val.length + ')]';
                  else if (val instanceof Set) entry[prop] = Array.from(val);
                  else entry[prop] = '{' + Object.keys(val).slice(0, 10).join(',') + '}';
                } else {
                  entry[prop] = val;
                }
              }
            } catch {}
          }

          results.push(entry);
        }

        return results;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(callResult.result?.value, null, 2));

  await client.close();
}

main().catch(console.error);
