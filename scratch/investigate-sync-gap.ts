#!/usr/bin/env bun
/**
 * Investigate whether CATEGORY_SOCIAL threads are in local SQLite
 * and whether a sync can be triggered.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = parseInt(process.env.CDP_PORT || "9250");

async function main() {
  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });

  // Connect to the eddyhu@gmail.com page specifically
  const gmailPage = targets.find(
    (t) => t.url.includes("eddyhu@gmail.com") && t.type === "page"
  ) || targets.find(
    (t) => t.url.includes("mail.superhuman.com") && t.type === "page"
  );

  if (!gmailPage) { console.error("No Superhuman page found"); process.exit(1); }
  console.log(`Connected to: ${gmailPage.url}\n`);

  const client = await CDP({ host, port: CDP_PORT, target: gmailPage.id });
  const { Runtime } = client;
  await new Promise(r => setTimeout(r, 300));

  const run = async (label: string, expr: string) => {
    console.log(`\n=== ${label} ===`);
    const t0 = Date.now();
    try {
      const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true, timeout: 20000 });
      if (r.exceptionDetails) {
        console.log("EXCEPTION:", r.exceptionDetails.text);
        console.log("  ", r.exceptionDetails.exception?.description?.slice(0, 200));
      } else {
        console.log(JSON.stringify(r.result?.value, null, 2)?.slice(0, 3000));
      }
    } catch (e: any) { console.log("ERROR:", e.message); }
    console.log(`(${Date.now()-t0}ms)`);
  };

  // 1. What is the current account?
  await run("Current account", `
    (function() {
      return {
        email: window.GoogleAccount && window.GoogleAccount.emailAddress,
        url: location.href,
      };
    })()
  `);

  // 2. Check if CATEGORY_SOCIAL exists in list_ids table at all
  await run("CATEGORY_SOCIAL count in list_ids (via threadInternal.listAsync)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      return portal.invoke('threadInternal', 'listAsync', ['CATEGORY_SOCIAL', { limit: 5, query: '' }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return {
            count: threads.length,
            rawQueryUsed: r && r.query ? r.query.slice(0, 200) : null,
            firstId: threads[0] && (threads[0].json || threads[0]).id,
          };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 3. Check ALL list IDs and their counts for this account
  await run("All list IDs with counts", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var listIds = [
        'INBOX', 'SH_IMPORTANT', 'SH_OTHER', 'SH_ALL', 'SH_ARCHIVED',
        'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_PROMOTIONS',
        'CATEGORY_PERSONAL', 'CATEGORY_FORUMS',
        'UNREAD', 'STARRED', 'SENT', 'DRAFT', 'TRASH', 'SPAM',
        'DONE', 'ALL_MAIL',
      ];
      return Promise.all(
        listIds.map(function(id) {
          return portal.invoke('threadInternal', 'listAsync', [id, { limit: 500, query: '' }])
            .then(function(r) {
              var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
              return { id: id, count: threads.length };
            })
            .catch(function() { return { id: id, count: -1 }; });
        })
      ).then(function(results) {
        var nonEmpty = results.filter(function(r) { return r.count > 0; });
        return nonEmpty;
      });
    })()
  `);

  // 4. FTS search for 'uber' - how many results and what are their listIds?
  await run("FTS 'uber' results with listIds from threadInternal", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var sql = 'SELECT rowid, thread_id, thread_id AS subject, thread_id AS snippet FROM thread_search WHERE thread_search MATCH ?';
      return portal.invoke('searchTable', 'query', [sql, ['"uber"'], { limit: 20 }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return {
            ftsCount: threads.length,
            results: threads.slice(0, 10).map(function(t) {
              var json = t.json || {};
              if (typeof json === 'string') { try { json = JSON.parse(json); } catch(e) {} }
              var msgs = json.messages || [];
              var latest = Array.isArray(msgs) ? msgs[msgs.length-1] : Object.values(msgs||{})[0];
              return {
                id: json.id,
                listIds: t.listIds,
                subject: latest && latest.subject ? latest.subject.slice(0, 60) : '?',
                from: latest && latest.from ? (latest.from.email || latest.from) : '?',
                labelIds: latest && latest.labelIds,
              };
            })
          };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 5. Check the 'lists' table — what lists are tracked?
  await run("lists table contents (via searchTable raw query)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      // Try to query the lists table directly through the searchTable service
      return portal.invoke('searchTable', 'query', [
        'SELECT rowid, thread_id, thread_id AS subject, thread_id AS snippet FROM thread_search WHERE thread_search MATCH ?',
        ['"noreply"'],
        { limit: 5 }
      ]).then(function(r) {
        var threads = (r && r.threads) ? r.threads : [];
        return {
          ftsCountForNoreply: threads.length,
          sample: threads.slice(0, 3).map(function(t) {
            var json = t.json || {};
            if (typeof json === 'string') { try { json = JSON.parse(json); } catch(e) {} }
            var msgs = json.messages || [];
            var latest = Array.isArray(msgs) ? msgs[msgs.length-1] : Object.values(msgs||{})[0];
            return {
              from: latest && latest.from ? (latest.from.email || latest.from) : '?',
              labelIds: latest && latest.labelIds,
            };
          })
        };
      }).catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 6. Is there a 'disk' service or sync service available?
  await run("Portal services: disk, sync, gmail, background", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var services = ['disk', 'disk/sync', 'sync', 'gmail', 'gmail/sync', 'background', 'foreground', 'storage'];
      return Promise.all(services.map(function(svc) {
        return portal.invoke(svc, 'ping', [])
          .then(function(r) { return { svc: svc, ok: true, result: JSON.stringify(r).slice(0, 50) }; })
          .catch(function(e) { return { svc: svc, error: e.message.slice(0, 60) }; });
      }));
    })()
  `);

  // 7. Check what sync services exist on the background page
  await run("Background page sync/gmail services", `
    (function() {
      var ga = window.GoogleAccount;
      if (!ga) return { error: 'no ga' };
      // Look for sync-related properties
      var allKeys = [];
      var obj = ga;
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) { allKeys.push(k); });
        obj = Object.getPrototypeOf(obj);
      }
      var syncKeys = allKeys.filter(function(k) { return /sync|gmail|fetch|pull|refresh|update/i.test(k); });
      return { syncRelatedKeys: Array.from(new Set(syncKeys)).slice(0, 40) };
    })()
  `);

  // 8. Check the backend for a categories sync endpoint
  await run("backend sync-related methods", `
    (function() {
      var backend = window.GoogleAccount && window.GoogleAccount.backend;
      if (!backend) return { error: 'no backend' };
      var allKeys = [];
      var obj = backend;
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) { allKeys.push(k); });
        obj = Object.getPrototypeOf(obj);
      }
      var syncKeys = allKeys.filter(function(k) { return /sync|category|social|pull|fetch|refresh/i.test(k); });
      return { syncRelatedKeys: Array.from(new Set(syncKeys)).slice(0, 40) };
    })()
  `);

  // 9. Try calling userdata.sync to trigger a full sync
  await run("Trigger userdata.sync via portal (callBackground)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var services = ['userdata', 'userdata/sync', 'gmail/userdata', 'foreground/userdata'];
      return Promise.all(services.map(function(svc) {
        return portal.invoke(svc, 'sync', [{}])
          .then(function(r) { return { svc: svc, ok: true }; })
          .catch(function(e) { return { svc: svc, error: e.message.slice(0, 80) }; });
      }));
    })()
  `);

  // 10. Check what labels Superhuman is tracking — are Social tabs enabled?
  await run("Superhuman tracked labels/categories", `
    (function() {
      var ga = window.GoogleAccount;
      if (!ga) return { error: 'no ga' };
      return {
        categoriesEnabled: ga.categoriesEnabled,
        socialEnabled: ga.socialEnabled,
        labelsInbox: ga.labelsInbox,
        inboxType: ga.inboxType,
        splitInbox: ga.splitInbox,
        splitInboxType: ga.splitInboxType,
        lists: ga.lists,
        syncedLists: ga.syncedLists,
        trackedLists: ga.trackedLists,
      };
    })()
  `);

  await client.close();
}

main().catch(console.error);
