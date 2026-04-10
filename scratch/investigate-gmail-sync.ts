#!/usr/bin/env bun
/**
 * Investigate: can we trigger CATEGORY_SOCIAL sync for eddyhu@gmail.com?
 * Run against the Gmail tab specifically.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = parseInt(process.env.CDP_PORT || "9250");

async function main() {
  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });

  // Force the Gmail tab
  const gmailPage = targets.find(
    (t: any) => t.url.includes("eddyhu@gmail.com") && t.type === "page"
  );
  if (!gmailPage) {
    console.error("eddyhu@gmail.com tab not found. Open tabs:");
    targets.filter((t: any) => t.url.includes("superhuman")).forEach((t: any) => console.log(" ", t.url));
    process.exit(1);
  }
  console.log(`Connected to: ${gmailPage.url}\n`);

  const client = await CDP({ host, port: CDP_PORT, target: gmailPage.id });
  const { Runtime } = client;
  await new Promise(r => setTimeout(r, 300));

  const run = async (label: string, expr: string, timeout = 20000) => {
    console.log(`\n=== ${label} ===`);
    const t0 = Date.now();
    try {
      const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true, timeout });
      if (r.exceptionDetails) {
        console.log("EXCEPTION:", r.exceptionDetails.text);
        console.log("  ", r.exceptionDetails.exception?.description?.slice(0, 300));
      } else {
        console.log(JSON.stringify(r.result?.value, null, 2)?.slice(0, 3000));
      }
    } catch (e: any) { console.log("ERROR:", e.message); }
    console.log(`(${Date.now()-t0}ms)`);
  };

  // 1. Confirm we're on the right account and check CATEGORY_SOCIAL count
  await run("Confirm account + CATEGORY_SOCIAL count", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      return portal.invoke('threadInternal', 'listAsync', ['CATEGORY_SOCIAL', { limit: 5, query: '' }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return { account: window.GoogleAccount && window.GoogleAccount.emailAddress, count: threads.length };
        });
    })()
  `);

  // 2. Check what GA sync methods exist
  await run("GoogleAccount sync methods", `
    (function() {
      var ga = window.GoogleAccount;
      if (!ga) return { error: 'no ga' };
      var allKeys = [];
      var obj = ga;
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) { allKeys.push(k); });
        obj = Object.getPrototypeOf(obj);
      }
      return {
        syncKeys: Array.from(new Set(allKeys)).filter(function(k) {
          return /sync|fetch|pull|refresh|lists?|categor/i.test(k);
        }).slice(0, 40)
      };
    })()
  `);

  // 3. Try backend.syncUserData
  await run("backend.syncUserData()", `
    (function() {
      var backend = window.GoogleAccount && window.GoogleAccount.backend;
      if (!backend || typeof backend.syncUserData !== 'function')
        return { error: 'no syncUserData', type: typeof (backend && backend.syncUserData) };
      return backend.syncUserData()
        .then(function(r) { return { ok: true, result: JSON.stringify(r).slice(0, 200) }; })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 4. Check if there's a lists DI service
  await run("portal lists service", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var services = ['lists', 'list', 'gmail/lists', 'disk/lists', 'foreground/lists', 'listSync', 'categorySync'];
      return Promise.all(services.map(function(svc) {
        return portal.invoke(svc, 'getAll', [])
          .then(function(r) { return { svc: svc, ok: true, result: JSON.stringify(r).slice(0, 100) }; })
          .catch(function(e) { return { svc: svc, error: e.message.slice(0, 60) }; });
      }));
    })()
  `);

  // 5. Try portal invoke 'threadInternal' 'syncList' or 'fetchList'
  await run("threadInternal sync/fetch methods", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var methods = ['syncList', 'fetchList', 'syncAsync', 'refreshAsync', 'fetchAsync', 'syncListAsync'];
      return Promise.all(methods.map(function(m) {
        return portal.invoke('threadInternal', m, ['CATEGORY_SOCIAL', {}])
          .then(function(r) { return { method: m, ok: true }; })
          .catch(function(e) { return { method: m, error: e.message.slice(0, 80) }; });
      }));
    })()
  `);

  // 6. Check ga._onSyncFromGmailUpdate and _onListsSyncedFromBackground
  await run("GA sync callback inspection", `
    (function() {
      var ga = window.GoogleAccount;
      if (!ga) return {};
      return {
        onSyncFromGmailUpdate: typeof ga._onSyncFromGmailUpdate,
        onListsSyncedFromBackground: typeof ga._onListsSyncedFromBackground,
        // Can we call these to trigger sync?
        canCallSyncFromGmail: typeof ga._onSyncFromGmailUpdate === 'function',
        canCallListsSynced: typeof ga._onListsSyncedFromBackground === 'function',
      };
    })()
  `);

  // 7. Try calling _onSyncFromGmailUpdate with CATEGORY_SOCIAL
  await run("Call _onSyncFromGmailUpdate (trigger Gmail sync)", `
    (function() {
      var ga = window.GoogleAccount;
      if (!ga || typeof ga._onSyncFromGmailUpdate !== 'function')
        return { error: 'not a function' };
      try {
        // Try passing a fake sync payload for CATEGORY_SOCIAL
        ga._onSyncFromGmailUpdate({ listId: 'CATEGORY_SOCIAL', force: true });
        return { called: true };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  // 8. Check the SW (service worker) for sync endpoints
  // Monitor network for a moment after any triggered syncs
  await run("CATEGORY_SOCIAL count after sync attempts", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      return portal.invoke('threadInternal', 'listAsync', ['CATEGORY_SOCIAL', { limit: 200, query: '' }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return {
            count: threads.length,
            sample: threads.slice(0, 3).map(function(t) {
              var json = t.json || t;
              if (typeof json === 'string') try { json = JSON.parse(json); } catch(e) {}
              var msgs = Array.isArray(json.messages) ? json.messages : Object.values(json.messages || {});
              var latest = msgs[msgs.length - 1] || {};
              return { id: json.id, subject: (latest.subject || '').slice(0, 60), from: latest.from && (latest.from.email || latest.from) };
            })
          };
        });
    })()
  `);

  // 9. Check what lists Superhuman considers "tracked" vs "synced"
  await run("GA lists / trackedLists / syncedLists properties", `
    (function() {
      var ga = window.GoogleAccount;
      if (!ga) return {};
      // Traverse and find list-related props
      var obj = ga;
      var found = {};
      var checked = new Set();
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) {
          if (checked.has(k)) return;
          checked.add(k);
          if (!/list|categor|track|sync|label|inbox/i.test(k)) return;
          var v = ga[k];
          if (v === undefined || v === null) return;
          if (typeof v === 'function') return;
          try { found[k] = JSON.stringify(v).slice(0, 200); } catch(e) {}
        });
        obj = Object.getPrototypeOf(obj);
      }
      return found;
    })()
  `);

  // 10. Try fetching category social threads via portal background callAsync
  await run("background callAsync fetchListFromGmail CATEGORY_SOCIAL", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      // Try known background service names for fetching a list
      var calls = [
        ['disk/threads', 'fetchList', ['CATEGORY_SOCIAL', { limit: 10 }]],
        ['disk/threads', 'getList', ['CATEGORY_SOCIAL', { limit: 10 }]],
        ['foreground/threads', 'fetchList', ['CATEGORY_SOCIAL']],
        ['disk/threadList', 'fetchAsync', ['CATEGORY_SOCIAL', {}]],
      ];
      return Promise.all(calls.map(function(c) {
        return portal.invoke(c[0], c[1], c[2])
          .then(function(r) { return { svc: c[0]+'.'+c[1], ok: true, result: JSON.stringify(r).slice(0, 100) }; })
          .catch(function(e) { return { svc: c[0]+'.'+c[1], error: e.message.slice(0, 80) }; });
      }));
    })()
  `);

  await client.close();
}

main().catch(console.error);
