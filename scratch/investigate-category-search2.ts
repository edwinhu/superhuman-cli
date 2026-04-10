#!/usr/bin/env bun
/**
 * Check whether CATEGORY_SOCIAL threads are in the FTS index.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = parseInt(process.env.CDP_PORT || "9250");
const QUERY = process.argv[2] || "uber";

async function main() {
  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });

  const shTarget = targets.find(
    (t) => t.url.includes("mail.superhuman.com") && t.type === "page"
  );
  if (!shTarget) { console.error("No Superhuman page found"); process.exit(1); }
  console.log(`Connected to: ${shTarget.url}\n`);

  const client = await CDP({ host, port: CDP_PORT, target: shTarget.id });
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

  // 1. Get CATEGORY_SOCIAL thread IDs from local DB
  await run("CATEGORY_SOCIAL threads (first 20)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      return portal.invoke('threadInternal', 'listAsync', ['CATEGORY_SOCIAL', { limit: 20, query: '' }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return {
            count: threads.length,
            ids: threads.slice(0, 10).map(function(t) {
              var json = t.json || t;
              return json.id || t.id || t.threadId;
            }),
            firstSubject: threads.slice(0, 5).map(function(t) {
              var json = t.json || t;
              var msgs = json.messages || [];
              var latest = Array.isArray(msgs) ? msgs[msgs.length-1] : Object.values(msgs||{})[0];
              return latest && latest.subject ? latest.subject.slice(0, 60) : '(no subject)';
            })
          };
        });
    })()
  `);

  // 2. FTS search with simple SELECT (no SNIPPET) — check if it needs subject/snippet columns
  await run("FTS search (simple, no SNIPPET)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var matchExpr = '"' + ${JSON.stringify(QUERY)}.replace(/"/g, '""') + '"';
      var sql = 'SELECT rowid, thread_id, thread_id AS subject, thread_id AS snippet FROM thread_search WHERE thread_search MATCH ?';
      return portal.invoke('searchTable', 'query', [sql, [matchExpr], { limit: 20 }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return {
            count: threads.length,
            threadIds: threads.slice(0, 10).map(function(t) { return t.thread_id; })
          };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 3. Cross check: are any of those FTS thread IDs in CATEGORY_SOCIAL?
  await run("Cross-check FTS results vs CATEGORY_SOCIAL", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var matchExpr = '"' + ${JSON.stringify(QUERY)}.replace(/"/g, '""') + '"';
      var sql = 'SELECT rowid, thread_id, thread_id AS subject, thread_id AS snippet FROM thread_search WHERE thread_search MATCH ?';

      var socialIds = new Set();
      var ftsIds = new Set();

      return Promise.all([
        portal.invoke('threadInternal', 'listAsync', ['CATEGORY_SOCIAL', { limit: 500, query: '' }]),
        portal.invoke('searchTable', 'query', [sql, [matchExpr], { limit: 100 }]),
      ]).then(function(results) {
        var socialResult = results[0];
        var ftsResult = results[1];

        var socialThreads = (socialResult && socialResult.threads) ? socialResult.threads : (Array.isArray(socialResult) ? socialResult : []);
        socialThreads.forEach(function(t) {
          var id = (t.json || t).id || t.id;
          if (id) socialIds.add(id);
        });

        var ftsThreads = (ftsResult && ftsResult.threads) ? ftsResult.threads : (Array.isArray(ftsResult) ? ftsResult : []);
        ftsThreads.forEach(function(t) {
          if (t.thread_id) ftsIds.add(t.thread_id);
        });

        var socialArr = Array.from(socialIds);
        var inFTS = socialArr.filter(function(id) { return ftsIds.has(id); });
        var notInFTS = socialArr.filter(function(id) { return !ftsIds.has(id); });

        return {
          socialCount: socialIds.size,
          ftsCount: ftsIds.size,
          socialFoundInFTS: inFTS.length,
          socialMissingFromFTS: notInFTS.length,
          ftsIds: Array.from(ftsIds).slice(0, 10),
          note: ftsIds.size === 0 ? 'FTS returned 0 results for query' : (notInFTS.length > 0 ? 'CONFIRMED gap: social threads missing from FTS' : 'all social threads in FTS for this query'),
        };
      }).catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 4. FTS search with broader terms to check coverage
  await run("FTS search 'noreply' (should match many automated emails)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var sql = 'SELECT rowid, thread_id, thread_id AS subject, thread_id AS snippet FROM thread_search WHERE thread_search MATCH ?';
      return portal.invoke('searchTable', 'query', [sql, ['"noreply"'], { limit: 100 }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return { count: threads.length };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 5. Check if the searchTable has a separate filter for list scoping
  // Look at what the SearchTable background worker does — try calling with extra params
  await run("searchTable with query option (not just limit)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var matchExpr = '"' + ${JSON.stringify(QUERY)}.replace(/"/g, '""') + '"';
      var sql = 'SELECT rowid, thread_id, thread_id AS subject, thread_id AS snippet FROM thread_search WHERE thread_search MATCH ?';
      // Try option variants
      var opts = [
        { limit: 20, listId: 'ALL_MAIL' },
        { limit: 20, scope: 'all' },
        { limit: 20, query: '' },
      ];
      return Promise.all(opts.map(function(o) {
        return portal.invoke('searchTable', 'query', [sql, [matchExpr], o])
          .then(function(r) {
            var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
            return { opts: o, count: threads.length };
          })
          .catch(function(e) { return { opts: o, error: e.message.slice(0, 80) }; });
      }));
    })()
  `);

  // 6. Try the listAsync INBOX query parameter — does it do FTS or something else?
  await run("threadInternal.listAsync INBOX with query (uber)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      return portal.invoke('threadInternal', 'listAsync', ['INBOX', { limit: 20, query: ${JSON.stringify(QUERY)} }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return {
            count: threads.length,
            subjects: threads.slice(0, 5).map(function(t) {
              var json = t.json || t;
              var msgs = json.messages || [];
              var latest = Array.isArray(msgs) ? msgs[msgs.length-1] : Object.values(msgs||{})[0];
              return {
                id: json.id || t.id,
                listIds: t.listIds || t.list_ids,
                subject: latest && latest.subject ? latest.subject.slice(0, 70) : '?',
                from: latest && latest.from ? (latest.from.email || latest.from) : '?',
              };
            })
          };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 7. Try CATEGORY_SOCIAL with uber query
  await run("threadInternal.listAsync CATEGORY_SOCIAL with query (uber)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      return portal.invoke('threadInternal', 'listAsync', ['CATEGORY_SOCIAL', { limit: 20, query: ${JSON.stringify(QUERY)} }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return {
            count: threads.length,
            subjects: threads.slice(0, 5).map(function(t) {
              var json = t.json || t;
              var msgs = json.messages || [];
              var latest = Array.isArray(msgs) ? msgs[msgs.length-1] : Object.values(msgs||{})[0];
              return {
                id: json.id || t.id,
                listIds: t.listIds || t.list_ids,
                subject: latest && latest.subject ? latest.subject.slice(0, 70) : '?',
                from: latest && latest.from ? (latest.from.email || latest.from) : '?',
              };
            })
          };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  await client.close();
}

main().catch(console.error);
