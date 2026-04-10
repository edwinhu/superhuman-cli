#!/usr/bin/env bun
/**
 * Investigate Superhuman full-mailbox search.
 *
 * 1. Lists available portal DI services to find search-related ones
 * 2. Tries threadInternal.searchAsync (if it exists)
 * 3. Monitors network traffic while invoking portal search methods
 * 4. Tries "done" / DONE_LIST / ALL_MAIL list IDs in threadInternal.listAsync
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

  // Monitor ALL targets for network requests
  const networkCaptures: string[] = [];
  for (const target of targets) {
    if (!target.url || target.url === "about:blank") continue;
    try {
      const c = await CDP({ host, port: CDP_PORT, target: target.id });
      await c.Network.enable({ maxPostDataSize: 65536 });
      c.Network.requestWillBeSent((p: any) => {
        const url: string = p.request.url;
        if (!url.includes("superhuman.com") && !url.includes("firebase")) return;
        if (url.match(/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/)) return;
        const body = p.request.postData ? `\n  Body: ${p.request.postData.slice(0, 300)}` : "";
        const entry = `[${target.type}] ${p.request.method} ${url}${body}`;
        networkCaptures.push(entry);
        console.log("NET:", entry);
      });
    } catch {}
  }

  const client = await CDP({ host, port: CDP_PORT, target: shTarget.id });
  const { Runtime } = client;

  const run = async (label: string, expr: string) => {
    console.log(`\n=== ${label} ===`);
    try {
      const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 });
      if (r.exceptionDetails) console.log("EXCEPTION:", r.exceptionDetails.text, r.exceptionDetails.exception?.description);
      else console.log(JSON.stringify(r.result?.value, null, 2)?.slice(0, 2000));
    } catch (e: any) { console.log("ERROR:", e.message); }
  };

  await new Promise(r => setTimeout(r, 300));

  // 1. Enumerate all portal DI services
  await run("Portal DI services (all keys)", `
    (() => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      // Try to find the DI container
      const candidates = ['_di', 'di', '_container', 'container', '_registry', 'registry'];
      for (const k of candidates) {
        const di = portal[k];
        if (di && typeof di.get === 'function') {
          // Iterate over known service names
          const found = {};
          const names = Object.getOwnPropertyNames(di).concat(
            Object.getOwnPropertyNames(Object.getPrototypeOf(di))
          );
          return { diType: di.constructor?.name, diKeys: names.slice(0, 100) };
        }
      }
      // Try portal itself
      return {
        portalKeys: Object.keys(portal).slice(0, 100),
        portalProtoKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(portal)).slice(0, 50),
      };
    })()
  `);

  // 2. Check what methods threadInternal has
  await run("threadInternal methods", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      try {
        // Get the service descriptor
        const r = await portal.invoke('threadInternal', '__getMethods__', []);
        return r;
      } catch {}
      // Try introspecting via a known method that returns metadata
      return { tried: '__getMethods__', note: 'failed, trying invoke with bad args to see error' };
    })()
  `);

  // 3. Try threadInternal.searchAsync (common pattern for search)
  await run("threadInternal.searchAsync", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      try {
        const r = await portal.invoke('threadInternal', 'searchAsync', [
          { query: ${JSON.stringify(QUERY)}, limit: 5 }
        ]);
        return { success: true, type: typeof r, sample: JSON.stringify(r)?.slice(0, 500) };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  // 4. Try threadInternal.listAsync with DONE list
  await run("threadInternal.listAsync DONE", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      try {
        const r = await portal.invoke('threadInternal', 'listAsync', [
          'DONE', { limit: 5, query: ${JSON.stringify(QUERY)} }
        ]);
        return { success: true, count: r?.threads?.length ?? r?.length, sample: JSON.stringify(r)?.slice(0, 500) };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  // 5. Try listAsync with ALL_MAIL
  await run("threadInternal.listAsync ALL_MAIL with query", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      try {
        const r = await portal.invoke('threadInternal', 'listAsync', [
          'ALL_MAIL', { limit: 5, query: ${JSON.stringify(QUERY)} }
        ]);
        return { success: true, count: r?.threads?.length ?? r?.length, sample: JSON.stringify(r)?.slice(0, 500) };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  // 6. Try listAsync INBOX with non-empty query (does it filter?)
  await run("threadInternal.listAsync INBOX with query", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      try {
        const r = await portal.invoke('threadInternal', 'listAsync', [
          'INBOX', { limit: 5, query: ${JSON.stringify(QUERY)} }
        ]);
        return { success: true, count: r?.threads?.length ?? r?.length, sample: JSON.stringify(r)?.slice(0, 500) };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  // 7. Look for search-related methods on window.GoogleAccount directly
  await run("window.GoogleAccount search-related keys", `
    (() => {
      const ga = window.GoogleAccount;
      if (!ga) return { error: 'no ga' };
      const allKeys = [];
      let obj = ga;
      while (obj && obj !== Object.prototype) {
        allKeys.push(...Object.getOwnPropertyNames(obj));
        obj = Object.getPrototypeOf(obj);
      }
      const searchKeys = allKeys.filter(k => /search|query|find|fts|full/i.test(k));
      return { searchKeys: [...new Set(searchKeys)].slice(0, 50) };
    })()
  `);

  // 8. Check backend object for search methods
  await run("backend search methods", `
    (() => {
      const backend = window.GoogleAccount?.backend;
      if (!backend) return { error: 'no backend' };
      const allKeys = [];
      let obj = backend;
      while (obj && obj !== Object.prototype) {
        allKeys.push(...Object.getOwnPropertyNames(obj));
        obj = Object.getPrototypeOf(obj);
      }
      const searchKeys = allKeys.filter(k => /search|query|find|fts/i.test(k));
      return { searchKeys: [...new Set(searchKeys)].slice(0, 50) };
    })()
  `);

  // 9. Try searching with searchTableProxy — the DI proxy service name
  await run("disk/searchTableProxy via portal", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      // Try variants of the service name
      const services = ['disk/searchTableProxy', 'searchTableProxy', 'disk/search', 'fullSearch'];
      for (const svc of services) {
        try {
          const r = await portal.invoke(svc, 'query', [
            'SELECT rowid, thread_id FROM thread_search WHERE thread_search MATCH ?',
            [${JSON.stringify(QUERY)}],
            { limit: 5 }
          ]);
          return { success: true, service: svc, result: JSON.stringify(r)?.slice(0, 500) };
        } catch(e) {
          console.log(svc, '->', e.message);
        }
      }
      return { tried: services, note: 'all failed' };
    })()
  `);

  // 10. Directly check what listIds / labels exist (to find DONE/ALL_MAIL equivalents)
  await run("Available listIds via threadInternal.listAsync error probe", `
    (async () => {
      const portal = window.GoogleAccount?.portal;
      if (!portal) return { error: 'no portal' };
      const listIds = ['DONE', 'ALL_MAIL', 'ALL', 'ARCHIVE', 'SEARCH', 'TRASH', 'SPAM'];
      const results = {};
      for (const listId of listIds) {
        try {
          const r = await portal.invoke('threadInternal', 'listAsync', [listId, { limit: 2, query: '' }]);
          results[listId] = { ok: true, count: r?.threads?.length ?? r?.length ?? JSON.stringify(r)?.slice(0, 100) };
        } catch(e) {
          results[listId] = { error: e.message.slice(0, 100) };
        }
      }
      return results;
    })()
  `);

  console.log("\n=== Network captures summary ===");
  console.log(`Total: ${networkCaptures.length}`);
  networkCaptures.forEach(c => console.log(c));

  await client.close();
}

main().catch(console.error);
