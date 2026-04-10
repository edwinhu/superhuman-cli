#!/usr/bin/env bun
/**
 * Switch to eddyhu@gmail.com tab, then investigate CATEGORY_SOCIAL sync.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = parseInt(process.env.CDP_PORT || "9250");
const GMAIL = "eddyhu@gmail.com";

async function main() {
  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });

  console.log("Open Superhuman tabs:");
  targets.filter((t: any) => t.url.includes("superhuman")).forEach((t: any) =>
    console.log(" ", t.type, t.url)
  );

  // Use whatever page is available
  const mainPage = targets.find(
    (t: any) => t.url.includes("mail.superhuman.com") && t.type === "page"
  );
  if (!mainPage) { console.error("No Superhuman page"); process.exit(1); }
  console.log(`\nUsing: ${mainPage.url}\n`);

  const client = await CDP({ host, port: CDP_PORT, target: mainPage.id });
  const { Runtime, Page } = client;
  await client.Page.enable();
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

  // Navigate to Gmail account
  console.log(`Navigating to ${GMAIL}...`);
  await Page.navigate({ url: `https://mail.superhuman.com/${GMAIL}` });
  await new Promise(r => setTimeout(r, 3000));

  // Wait for page to load
  await run("Confirm account after navigation", `
    (function() {
      return {
        email: window.GoogleAccount && window.GoogleAccount.emailAddress,
        url: location.href,
      };
    })()
  `);

  // Check CATEGORY_SOCIAL count
  await run("CATEGORY_SOCIAL thread count", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      return portal.invoke('threadInternal', 'listAsync', ['CATEGORY_SOCIAL', { limit: 200, query: '' }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return {
            count: threads.length,
            sample: threads.slice(0, 5).map(function(t) {
              var json = t.json || t;
              if (typeof json === 'string') try { json = JSON.parse(json); } catch(e) {}
              var msgs = Array.isArray(json.messages) ? json.messages : Object.values(json.messages || {});
              var latest = msgs[msgs.length - 1] || {};
              return {
                id: json.id,
                listIds: t.listIds,
                subject: (latest.subject || '').slice(0, 60),
                from: latest.from && (latest.from.email || latest.from),
              };
            })
          };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // FTS uber search
  await run("FTS 'uber' search", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var sql = 'SELECT rowid, thread_id, thread_id AS subject, thread_id AS snippet FROM thread_search WHERE thread_search MATCH ?';
      return portal.invoke('searchTable', 'query', [sql, ['"uber"'], { limit: 20 }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return {
            count: threads.length,
            results: threads.map(function(t) {
              var json = t.json || {};
              if (typeof json === 'string') try { json = JSON.parse(json); } catch(e) {}
              var msgs = Array.isArray(json.messages) ? json.messages : Object.values(json.messages || {});
              var latest = msgs[msgs.length - 1] || {};
              return {
                id: json.id,
                subject: (latest.subject || '').slice(0, 60),
                from: latest.from && (latest.from.email || latest.from),
                labelIds: latest.labelIds,
              };
            })
          };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // Check all list IDs
  await run("All list counts for this account", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var listIds = ['INBOX','SH_IMPORTANT','SH_OTHER','SH_ALL','SH_ARCHIVED','CATEGORY_SOCIAL','CATEGORY_UPDATES','CATEGORY_PROMOTIONS','CATEGORY_PERSONAL','UNREAD','STARRED','SENT','DRAFT','TRASH','SPAM'];
      return Promise.all(listIds.map(function(id) {
        return portal.invoke('threadInternal', 'listAsync', [id, { limit: 500, query: '' }])
          .then(function(r) {
            var t = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
            return { id: id, count: t.length };
          }).catch(function() { return { id: id, count: -1 }; });
      })).then(function(results) { return results.filter(function(r) { return r.count > 0; }); });
    })()
  `);

  // Try triggering a sync of CATEGORY_SOCIAL via backend.syncUserData
  await run("backend.syncUserData()", `
    (function() {
      var backend = window.GoogleAccount && window.GoogleAccount.backend;
      if (!backend || typeof backend.syncUserData !== 'function') return { error: 'no syncUserData' };
      return backend.syncUserData()
        .then(function(r) { return { ok: true, result: JSON.stringify(r).slice(0, 200) }; })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // Check GA list-related properties
  await run("GA list-related properties", `
    (function() {
      var ga = window.GoogleAccount;
      if (!ga) return {};
      var found = {};
      var checked = new Set();
      var obj = ga;
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) {
          if (checked.has(k)) return; checked.add(k);
          if (!/list|categor|track|sync|label|inbox|split/i.test(k)) return;
          var v = ga[k];
          if (v == null || typeof v === 'function') return;
          try { found[k] = JSON.stringify(v).slice(0, 200); } catch(e) {}
        });
        obj = Object.getPrototypeOf(obj);
      }
      return found;
    })()
  `);

  // Try calling resyncLabels
  await run("backend.resyncLabels()", `
    (function() {
      var backend = window.GoogleAccount && window.GoogleAccount.backend;
      if (!backend || typeof backend.resyncLabels !== 'function') return { error: 'no resyncLabels' };
      return backend.resyncLabels()
        .then(function(r) { return { ok: true }; })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // Wait and re-check CATEGORY_SOCIAL count after sync attempts
  console.log("\nWaiting 3s after sync attempts...");
  await new Promise(r => setTimeout(r, 3000));

  await run("CATEGORY_SOCIAL count after sync", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      return portal.invoke('threadInternal', 'listAsync', ['CATEGORY_SOCIAL', { limit: 200, query: '' }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return { count: threads.length };
        }).catch(function(e) { return { error: e.message }; });
    })()
  `);

  // Try portal invoke for disk/threadList methods
  await run("disk service methods", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var svcs = ['disk', 'disk/threadList', 'disk/list', 'disk/threads', 'disk/sync', 'disk/gmail'];
      return Promise.all(svcs.map(function(svc) {
        return portal.invoke(svc, 'syncList', ['CATEGORY_SOCIAL'])
          .then(function(r) { return { svc: svc, ok: true }; })
          .catch(function(e) { return { svc: svc, error: e.message.slice(0, 70) }; });
      }));
    })()
  `);

  await client.close();
}

main().catch(console.error);
