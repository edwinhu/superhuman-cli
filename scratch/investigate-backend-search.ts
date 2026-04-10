#!/usr/bin/env bun
/**
 * Investigate:
 * 1. backend.semanticSearch method signature and what it hits
 * 2. What network requests happen when Superhuman UI search is triggered
 * 3. The window.GoogleAccount.query property
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

  // Monitor ALL targets for network requests (especially service worker)
  const networkCaptures: {time: number, entry: string}[] = [];
  const monitorClients: any[] = [];
  for (const target of targets) {
    if (!target.url || target.url === "about:blank") continue;
    try {
      const c = await CDP({ host, port: CDP_PORT, target: target.id });
      await c.Network.enable({ maxPostDataSize: 65536 });
      c.Network.requestWillBeSent((p: any) => {
        const url: string = p.request.url;
        if (!url.includes("superhuman.com")) return;
        if (url.match(/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/)) return;
        if (url.includes("gcal") || url.includes("microsoftCalendar") || url.includes("media.super")) return;
        const body = p.request.postData ? `\n  Body: ${p.request.postData.slice(0, 400)}` : "";
        const entry = `[${target.type}] ${p.request.method} ${url}${body}`;
        networkCaptures.push({time: Date.now(), entry});
        console.log("NET:", entry);
      });
      monitorClients.push(c);
    } catch {}
  }

  const client = await CDP({ host, port: CDP_PORT, target: shTarget.id });
  const { Runtime } = client;
  await new Promise(r => setTimeout(r, 300));

  const run = async (label: string, expr: string) => {
    console.log(`\n=== ${label} ===`);
    const t0 = Date.now();
    try {
      const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 });
      if (r.exceptionDetails) console.log("EXCEPTION:", r.exceptionDetails.text, r.exceptionDetails.exception?.description?.slice(0, 300));
      else console.log(JSON.stringify(r.result?.value, null, 2)?.slice(0, 3000));
    } catch (e: any) { console.log("ERROR:", e.message); }
    console.log(`(${Date.now()-t0}ms)`);
  };

  // 1. Inspect backend.semanticSearch
  await run("backend.semanticSearch signature", `
    (() => {
      const backend = window.GoogleAccount?.backend;
      if (!backend) return { error: 'no backend' };
      return {
        semanticSearch: backend.semanticSearch?.toString()?.slice(0, 500),
        semanticSearchSuggestions: backend.semanticSearchSuggestions?.toString()?.slice(0, 300),
        semanticSearchUserWarmUp: backend.semanticSearchUserWarmUp?.toString()?.slice(0, 300),
        updateSearchHistory: backend.updateSearchHistory?.toString()?.slice(0, 300),
      };
    })()
  `);

  // 2. Call backend.semanticSearch
  await run("backend.semanticSearch call", `
    (async () => {
      const backend = window.GoogleAccount?.backend;
      if (!backend?.semanticSearch) return { error: 'no semanticSearch' };
      try {
        const r = await backend.semanticSearch(${JSON.stringify(QUERY)}, { limit: 5 });
        return { success: true, type: typeof r, keys: r ? Object.keys(r).join(',') : null, sample: JSON.stringify(r)?.slice(0, 1000) };
      } catch(e) {
        return { error: e.message, stack: e.stack?.slice(0, 300) };
      }
    })()
  `);

  // 3. Check window.GoogleAccount.query
  await run("window.GoogleAccount.query", `
    (() => {
      const ga = window.GoogleAccount;
      return {
        queryType: typeof ga?.query,
        queryVal: typeof ga?.query === 'function' ? ga.query?.toString()?.slice(0, 300) : ga?.query,
        canUseAISemanticSearch: ga?.canUseAISemanticSearch,
        isTeamWebSearchDisabled: ga?.isTeamWebSearchDisabled,
      };
    })()
  `);

  // 4. Find the "search" action on the app — look for Search object / component
  await run("App search objects", `
    (() => {
      // Try to find window-level search objects
      const keys = Object.keys(window).filter(k => /search|Search/i.test(k) && k !== 'Symbol');
      return { windowSearchKeys: keys.slice(0, 30) };
    })()
  `);

  // 5. Look at the searchTable service directly to understand its scope
  await run("searchTable introspect", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      // Query the thread_search table directly — check what list IDs are present
      try {
        const r = await portal.invoke('searchTable', 'query', [
          'SELECT thread_id, rowid FROM thread_search LIMIT 3',
          [],
          { limit: 3 }
        ]);
        return { success: true, sample: JSON.stringify(r)?.slice(0, 500) };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  // 6. Check how many rows are in thread_search vs threads table
  await run("SQLite row counts", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      const results = {};
      // Count in thread_search
      try {
        const r = await portal.invoke('searchTable', 'query', [
          'SELECT count(*) as cnt FROM thread_search',
          [],
          { limit: 1 }
        ]);
        results['thread_search_count'] = r;
      } catch(e) {
        results['thread_search_count'] = { error: e.message };
      }
      // Count threads in INBOX
      try {
        const r = await portal.invoke('threadInternal', 'listAsync', ['INBOX', { limit: 100, query: '' }]);
        results['INBOX_count'] = r?.threads?.length ?? r?.length;
      } catch(e) {
        results['INBOX_count'] = { error: e.message };
      }
      // Count threads in DONE
      try {
        const r = await portal.invoke('threadInternal', 'listAsync', ['DONE', { limit: 100, query: '' }]);
        results['DONE_count'] = r?.threads?.length ?? r?.length;
      } catch(e) {
        results['DONE_count'] = { error: e.message };
      }
      return results;
    })()
  `);

  // 7. Try the userdata.searchThreads backend endpoint (server-side)
  await run("userdata.searchThreads backend", `
    (async () => {
      const backend = window.GoogleAccount?.backend;
      if (!backend) return { error: 'no backend' };
      // Try _request or request method directly
      const requestFn = backend._request || backend.request || backend.fetch;
      if (typeof requestFn !== 'function') return { error: 'no request fn', backendKeys: Object.keys(backend).slice(0, 20) };
      try {
        const r = await requestFn.call(backend, '/v3/userdata.searchThreads', {
          method: 'POST',
          body: JSON.stringify({ query: ${JSON.stringify(QUERY)}, limit: 5 })
        });
        return { success: true, status: r?.status, sample: JSON.stringify(r)?.slice(0, 500) };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  // 8. Try portal.invoke with threadSearch service (might differ from searchTable)
  await run("threadSearch portal service", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      const services = ['threadSearch', 'fullTextSearch', 'fts', 'search/full', 'disk/threadSearch'];
      for (const svc of services) {
        try {
          const r = await portal.invoke(svc, 'query', [${JSON.stringify(QUERY)}, { limit: 3 }]);
          return { success: true, service: svc, result: JSON.stringify(r)?.slice(0, 300) };
        } catch(e) {
          console.log(svc + ': ' + e.message);
        }
      }
      return { tried: services };
    })()
  `);

  // 9. Watch what the Superhuman UI does when we programmatically trigger search
  // Find the search input and type in it
  console.log("\n=== Triggering UI search (monitoring network) ===");
  console.log("Typing query into search box via keyboard shortcut...");
  await new Promise(r => setTimeout(r, 500));

  // In Superhuman, '/' or 'k' opens search. Let's use the keyboard shortcut.
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "/", text: "/", windowsVirtualKeyCode: 191 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "/", windowsVirtualKeyCode: 191 });
  await new Promise(r => setTimeout(r, 500));

  // Type the query
  for (const ch of QUERY) {
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: ch, text: ch });
    await client.Input.dispatchKeyEvent({ type: "char", key: ch, text: ch });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: ch });
    await new Promise(r => setTimeout(r, 50));
  }

  // Wait to capture network requests
  console.log("Waiting 5s for network requests from UI search...");
  await new Promise(r => setTimeout(r, 5000));

  // Press Escape to close search
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });

  console.log("\n=== All network captures ===");
  for (const c of networkCaptures) {
    console.log(`[${new Date(c.time).toISOString().slice(11,23)}] ${c.entry}`);
  }

  await client.close();
  for (const m of monitorClients) await m.close().catch(() => {});
}

main().catch(console.error);
