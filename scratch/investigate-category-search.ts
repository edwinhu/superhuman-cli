#!/usr/bin/env bun
/**
 * Investigate why FTS search misses CATEGORY_SOCIAL emails.
 *
 * Hypothesis: searchTable.query only indexes SH_IMPORTANT/SH_OTHER threads,
 * not CATEGORY_SOCIAL/CATEGORY_UPDATES/CATEGORY_PROMOTIONS threads.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = parseInt(process.env.CDP_PORT || "9250");
const QUERY = process.argv[2] || "uber";

async function main() {
  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });

  const shTarget = targets.find(
    (t: any) => t.url.includes("mail.superhuman.com") && t.type === "page"
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
      if (r.exceptionDetails) console.log("EXCEPTION:", r.exceptionDetails.text, r.exceptionDetails.exception?.description?.slice(0, 300));
      else console.log(JSON.stringify(r.result?.value, null, 2)?.slice(0, 3000));
    } catch (e: any) { console.log("ERROR:", e.message); }
    console.log(`(${Date.now()-t0}ms)`);
  };

  // 1. List ALL distinct list IDs that exist in local SQLite
  await run("All distinct list_ids in local DB", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      // Query each possible category list ID with listAsync
      const listIds = [
        'INBOX', 'SH_IMPORTANT', 'SH_OTHER',
        'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_PROMOTIONS', 'CATEGORY_FORUMS',
        'CATEGORY_PERSONAL', 'UNREAD', 'STARRED', 'SENT', 'DRAFT',
        'DONE', 'ALL_MAIL', 'TRASH', 'SPAM',
      ];
      const counts = {};
      for (const listId of listIds) {
        try {
          const r = await portal.invoke('threadInternal', 'listAsync', [listId, { limit: 200, query: '' }]);
          const count = r?.threads?.length ?? r?.length ?? 0;
          if (count > 0) counts[listId] = count;
        } catch(e) {
          // ignore
        }
      }
      return counts;
    })()
  `);

  // 2. Search FTS for query and check what list IDs those threads have
  await run(`FTS search "${QUERY}" — what list IDs?`, `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      // First, get thread IDs from FTS
      const words = ${JSON.stringify(QUERY)}.trim().split(/\\s+/).filter(Boolean);
      const matchExpr = words.map(w => '"' + w.replace(/"/g, '""') + '"').join(' ');
      const ellipsis = '\\u2026';
      const sql = 'SELECT rowid, thread_id, SNIPPET(thread_search, \\'<b>\\', \\'</b>\\', \\'' + ellipsis + '\\', 1, -64) AS subject FROM thread_search WHERE thread_search MATCH ?';
      try {
        const r = await portal.invoke('searchTable', 'query', [sql, [matchExpr], { limit: 20 }]);
        return { success: true, result: JSON.stringify(r)?.slice(0, 1000) };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  // 3. Check thread_search row count vs threads count
  await run("thread_search row count (via MATCH *)", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      try {
        // FTS3 doesn't support count(*) directly in this wrapper, but MATCH * selects all
        const r = await portal.invoke('searchTable', 'query', [
          'SELECT rowid, thread_id FROM thread_search WHERE thread_search MATCH ?',
          ['*'],
          { limit: 1000 }
        ]);
        // Count results
        const threads = r?.threads || r || [];
        return { fts_total_rows: Array.isArray(threads) ? threads.length : JSON.stringify(threads)?.slice(0, 200) };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  // 4. Try to get CATEGORY_SOCIAL threads and check if they have subject matching uber
  await run("CATEGORY_SOCIAL threads — first 20", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      try {
        const r = await portal.invoke('threadInternal', 'listAsync', ['CATEGORY_SOCIAL', { limit: 20, query: '' }]);
        const threads = r?.threads || r || [];
        if (!Array.isArray(threads) || threads.length === 0) return { count: 0, raw: JSON.stringify(r)?.slice(0, 200) };
        return {
          count: threads.length,
          sample: threads.slice(0, 5).map((t: any) => {
            const json = t.json || t;
            const msgs = json.messages || [];
            const latest = Array.isArray(msgs) ? msgs[msgs.length - 1] : Object.values(msgs)[0];
            return {
              id: json.id || t.id,
              listIds: t.listIds || t.list_ids,
              subject: (latest as any)?.subject?.slice(0, 80),
              from: (latest as any)?.from?.email || (latest as any)?.from,
            };
          })
        };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  // 5. Does FTS search miss CATEGORY_SOCIAL? Compare thread IDs
  await run("Cross-check: CATEGORY_SOCIAL thread IDs vs FTS results", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };

      // Get CATEGORY_SOCIAL thread IDs
      let socialIds: Set<string> = new Set();
      try {
        const r = await portal.invoke('threadInternal', 'listAsync', ['CATEGORY_SOCIAL', { limit: 200, query: '' }]);
        const threads = r?.threads || r || [];
        if (Array.isArray(threads)) {
          for (const t of threads) {
            const id = (t.json || t)?.id || t.id;
            if (id) socialIds.add(id);
          }
        }
      } catch(e) {
        return { error: 'social fetch failed: ' + e.message };
      }

      // Get ALL FTS-indexed thread IDs
      let ftsIds: Set<string> = new Set();
      try {
        // Use MATCH * to get all indexed threads — use a broad term
        const words = ${JSON.stringify(QUERY)}.trim().split(/\\s+/).filter(Boolean);
        const matchExpr = words.map((w: string) => '"' + w.replace(/"/g, '""') + '"').join(' ');
        const sql = 'SELECT rowid, thread_id FROM thread_search WHERE thread_search MATCH ?';
        const r = await portal.invoke('searchTable', 'query', [sql, [matchExpr], { limit: 100 }]);
        const results = r?.threads || r || [];
        if (Array.isArray(results)) {
          for (const row of results) {
            if (row.thread_id) ftsIds.add(row.thread_id);
          }
        }
      } catch(e) {
        return { error: 'fts fetch failed: ' + e.message, socialCount: socialIds.size };
      }

      const socialArr = [...socialIds];
      const ftsArr = [...ftsIds];
      const inFTS = socialArr.filter(id => ftsIds.has(id));
      const notInFTS = socialArr.filter(id => !ftsIds.has(id));

      return {
        socialCount: socialIds.size,
        ftsResultCount: ftsIds.size,
        socialInFTS: inFTS.length,
        socialNotInFTS: notInFTS.length,
        note: notInFTS.length > 0 ? 'CONFIRMED: social threads missing from FTS results' : 'all social threads appear in FTS for this query',
      };
    })()
  `);

  // 6. Try passing listIds to searchTable — does it have a filter option?
  await run("searchTable.query with includeDone option", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      const words = ${JSON.stringify(QUERY)}.trim().split(/\\s+/).filter(Boolean);
      const matchExpr = words.map((w: string) => '"' + w.replace(/"/g, '""') + '"').join(' ');
      const ellipsis = '\\u2026';
      const sql = 'SELECT rowid, thread_id, SNIPPET(thread_search, \\'<b>\\', \\'</b>\\', \\'' + ellipsis + '\\', 1, -64) AS subject FROM thread_search WHERE thread_search MATCH ?';
      // Try various option flags
      for (const opts of [
        { limit: 20 },
        { limit: 20, includeDone: true },
        { limit: 20, allMail: true },
        { limit: 20, listIds: ['INBOX', 'CATEGORY_SOCIAL', 'SH_IMPORTANT', 'SH_OTHER'] },
      ]) {
        try {
          const r = await portal.invoke('searchTable', 'query', [sql, [matchExpr], opts]);
          const threads = r?.threads || r || [];
          const count = Array.isArray(threads) ? threads.length : '?';
          console.log('opts=' + JSON.stringify(opts) + ' -> count=' + count);
        } catch(e) {
          console.log('opts=' + JSON.stringify(opts) + ' -> error: ' + e.message);
        }
      }
      return 'done';
    })()
  `);

  // 7. Look at the SearchTable source in the background page
  await run("SearchTable.query source (background page)", `
    (async () => {
      // Look for the SearchTable or searchTable DI registration
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      // Try to get the service object and inspect it
      try {
        // getAsync with a bad method to trigger error showing service name
        await portal.invoke('searchTable', '__inspect__', []);
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  await client.close();
}

main().catch(console.error);
