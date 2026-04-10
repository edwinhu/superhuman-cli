#!/usr/bin/env bun
/**
 * Properly parse FTS results (json field), check list IDs of found threads,
 * and figure out why CATEGORY_SOCIAL uber receipts aren't appearing.
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

  // 1. Run FTS and properly parse the result — show what threads it finds
  await run("FTS results properly parsed", `
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
            resultKeys: threads.length > 0 ? Object.keys(threads[0]) : [],
            rawFirst: JSON.stringify(threads[0])?.slice(0, 500),
            rawSecond: JSON.stringify(threads[1])?.slice(0, 300),
          };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 2. Parse FTS results properly — json field contains thread data
  await run("FTS results with json field parsed", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var matchExpr = '"' + ${JSON.stringify(QUERY)}.replace(/"/g, '""') + '"';
      var sql = 'SELECT rowid, thread_id, thread_id AS subject, thread_id AS snippet FROM thread_search WHERE thread_search MATCH ?';
      return portal.invoke('searchTable', 'query', [sql, [matchExpr], { limit: 20 }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return threads.slice(0, 10).map(function(t) {
            var json;
            try { json = typeof t.json === 'string' ? JSON.parse(t.json) : (t.json || {}); } catch(e) { json = {}; }
            var msgs = json.messages || [];
            var latest = Array.isArray(msgs) ? msgs[msgs.length-1] : Object.values(msgs||{})[0];
            return {
              id: json.id || t.id,
              listIds: t.listIds || t.list_ids,
              subject: latest && latest.subject ? latest.subject.slice(0, 80) : (json.subject || '?'),
              from: latest && latest.from ? (latest.from.email || latest.from) : '?',
              snippet: t.snippet ? t.snippet.slice(0, 80) : '?',
            };
          });
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 3. The current searchInboxSuperhuman uses SNIPPET — let's use it exactly as in production
  await run("FTS with SNIPPET (production query)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var matchExpr = '"' + ${JSON.stringify(QUERY)}.replace(/"/g, '""') + '"';
      // Build SQL exactly like buildFtsQuery in inbox.ts
      var e = '\\u2026';
      var sql = "SELECT rowid, thread_id, SNIPPET(thread_search, '<b>', '</b>', '" + e + "', 1, -64) AS subject, SNIPPET(thread_search, '<b>', '</b>', '" + e + "', 2, -15) AS snippet FROM thread_search WHERE thread_search MATCH ?";
      return portal.invoke('searchTable', 'query', [sql, [matchExpr], { limit: 20 }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return threads.slice(0, 10).map(function(t) {
            var json;
            try { json = typeof t.json === 'string' ? JSON.parse(t.json) : (t.json || {}); } catch(e) { json = {}; }
            var msgs = json.messages || [];
            var latest = Array.isArray(msgs) ? msgs[msgs.length-1] : Object.values(msgs||{})[0];
            return {
              id: json.id,
              listIds: t.listIds,
              subjectSnippet: t.subject ? t.subject.slice(0, 80) : '?',
              from: latest && latest.from ? (latest.from.email || latest.from) : '?',
            };
          });
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 4. Check if SH_ARCHIVED threads are indexed in FTS
  // Get 5 SH_ARCHIVED threads and check if any are in FTS
  await run("Are SH_ARCHIVED threads in FTS index?", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };

      // Get SH_ARCHIVED thread IDs from the CATEGORY_SOCIAL list
      return portal.invoke('threadInternal', 'listAsync', ['CATEGORY_SOCIAL', { limit: 100, query: '' }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          // Only keep SH_ARCHIVED ones
          var archivedThreads = threads.filter(function(t) {
            var ids = t.listIds || t.list_ids || [];
            return ids.indexOf('SH_ARCHIVED') !== -1;
          });
          var sampleIds = archivedThreads.slice(0, 5).map(function(t) {
            var json = t.json || t;
            return (typeof json === 'string' ? JSON.parse(json) : json).id || t.id;
          }).filter(Boolean);

          // Now check if any of these IDs appear in FTS using thread_id MATCH
          // Can't do direct ID lookup in FTS3 easily, so search for their thread IDs
          // using threadInternal to get their subjects, then search for those in FTS
          return {
            archivedCount: archivedThreads.length,
            notArchivedCount: threads.length - archivedThreads.length,
            sampleArchivedIds: sampleIds,
          };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 5. Search for a keyword that ONLY appears in a CATEGORY_SOCIAL/SH_ARCHIVED thread
  //    to test if archived social threads are indexed
  await run("Search for CATEGORY_SOCIAL-only keyword (linkedin)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      var sql = 'SELECT rowid, thread_id, thread_id AS subject, thread_id AS snippet FROM thread_search WHERE thread_search MATCH ?';
      return portal.invoke('searchTable', 'query', [sql, ['"linkedin"'], { limit: 10 }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return {
            ftsCount: threads.length,
            rawFirst: JSON.stringify(threads[0])?.slice(0, 400),
          };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 6. Try searchTable without MATCH to understand its wrapper SQL
  await run("searchTable no-WHERE query (all threads)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      // A query that returns all rows (FTS3 trick: match * via a very broad term)
      // Actually try selecting without WHERE to see if wrapper enforces it
      return portal.invoke('searchTable', 'query', [
        'SELECT rowid, thread_id, thread_id AS subject, thread_id AS snippet FROM thread_search LIMIT 5',
        [],
        { limit: 5 }
      ])
        .then(function(r) {
          return { success: true, raw: JSON.stringify(r)?.slice(0, 500) };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 7. Can we search ALL threads (bypass the default search scope) via a different SQL?
  await run("threads table direct query via searchTable", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      // Try querying the threads table directly via the searchTable service
      return portal.invoke('searchTable', 'query', [
        'SELECT rowid, t.thread_id, t.thread_id AS subject, t.thread_id AS snippet FROM threads t JOIN list_ids li ON t.thread_id = li.thread_id WHERE li.list_id = ? LIMIT 5',
        ['CATEGORY_SOCIAL'],
        { limit: 5 }
      ])
        .then(function(r) {
          return { success: true, raw: JSON.stringify(r)?.slice(0, 500) };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  await client.close();
}

main().catch(console.error);
