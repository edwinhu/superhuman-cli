#!/usr/bin/env bun
/**
 * Find Superhuman's server-side keyword search HTTP endpoint.
 * Monitor ALL network requests while triggering various search methods.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = parseInt(process.env.CDP_PORT || "9250");
const QUERY = process.argv[2] || "uber";

async function main() {
  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });

  const mainPage = targets.find(
    (t: any) => t.url.includes("mail.superhuman.com") && t.type === "page"
  );
  if (!mainPage) { console.error("No Superhuman page"); process.exit(1); }
  console.log(`Connected to: ${mainPage.url}\n`);

  // Monitor ALL targets for network requests
  const captured: {time: number, entry: string}[] = [];
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
        if (url.includes("metrics") || url.includes("labels.recentChanges")) return;
        const body = p.request.postData ? `\n  Body: ${p.request.postData.slice(0, 400)}` : "";
        captured.push({ time: Date.now(), entry: `[${target.type}] ${p.request.method} ${url}${body}` });
        console.log("NET:", `[${target.type}]`, p.request.method, url.replace("https://mail.superhuman.com", ""), body);
      });
    } catch {}
  }

  const client = await CDP({ host, port: CDP_PORT, target: mainPage.id });
  const { Runtime } = client;
  await new Promise(r => setTimeout(r, 500));

  const run = async (label: string, expr: string, timeout = 15000) => {
    console.log(`\n--- ${label} ---`);
    const before = captured.length;
    const t0 = Date.now();
    try {
      const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true, timeout });
      if (r.exceptionDetails) {
        console.log("EX:", r.exceptionDetails.text, r.exceptionDetails.exception?.description?.slice(0, 200));
      } else {
        const val = r.result?.value;
        if (val) console.log(JSON.stringify(val, null, 2).slice(0, 1000));
      }
    } catch (e: any) { console.log("ERR:", e.message); }
    const newRequests = captured.slice(before);
    if (newRequests.length > 0) console.log(`  ^ triggered ${newRequests.length} network request(s)`);
    console.log(`(${Date.now()-t0}ms)`);
    await new Promise(r => setTimeout(r, 300));
  };

  // 1. Check what backend methods involve search/find
  await run("backend search-related method signatures", `
    (function() {
      var backend = window.GoogleAccount && window.GoogleAccount.backend;
      if (!backend) return { error: 'no backend' };
      var result = {};
      ['semanticSearch', 'updateSearchHistory', 'semanticSearchSuggestions', 'fetchJSON', '_request', 'request'].forEach(function(k) {
        if (typeof backend[k] === 'function') {
          result[k] = backend[k].toString().slice(0, 200);
        }
      });
      return result;
    })()
  `);

  // 2. Try calling the backend directly with known endpoint patterns
  // Look for userdata.searchThreads
  await run("POST /v3/userdata.searchThreads", `
    (function() {
      var backend = window.GoogleAccount && window.GoogleAccount.backend;
      if (!backend || typeof backend.fetchJSON !== 'function') return { error: 'no fetchJSON' };
      return backend.fetchJSON('/~backend/v3/userdata.searchThreads', {
        endpoint: 'userdata.searchThreads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: ${JSON.stringify(QUERY)}, limit: 5 })
      }).then(function(r) { return { ok: true, keys: Object.keys(r||{}).join(','), sample: JSON.stringify(r).slice(0, 300) }; })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 3. Try userdata.getThreads with a query param
  await run("POST /v3/userdata.getThreads with query", `
    (function() {
      var backend = window.GoogleAccount && window.GoogleAccount.backend;
      if (!backend || typeof backend.fetchJSON !== 'function') return { error: 'no fetchJSON' };
      return backend.fetchJSON('/~backend/v3/userdata.getThreads', {
        endpoint: 'userdata.getThreads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: ${JSON.stringify(QUERY)}, limit: 5, offset: 0 })
      }).then(function(r) { return { ok: true, keys: Object.keys(r||{}).join(','), sample: JSON.stringify(r).slice(0, 300) }; })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 4. Try search.query or search.search
  await run("POST /v3/search.query", `
    (function() {
      var backend = window.GoogleAccount && window.GoogleAccount.backend;
      if (!backend || typeof backend.fetchJSON !== 'function') return { error: 'no fetchJSON' };
      return backend.fetchJSON('/~backend/v3/search.query', {
        endpoint: 'search.query',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: ${JSON.stringify(QUERY)}, limit: 5 })
      }).then(function(r) { return { ok: true, sample: JSON.stringify(r).slice(0, 300) }; })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 5. Check what the backend._backendToAppForSync does
  await run("backend._backendToAppForSync inspect", `
    (function() {
      var backend = window.GoogleAccount && window.GoogleAccount.backend;
      if (!backend) return {};
      return {
        backendToApp: typeof backend._backendToAppForSync === 'function' ?
          backend._backendToAppForSync.toString().slice(0, 300) : 'not a function',
      };
    })()
  `);

  // 6. Trigger the actual UI search and monitor what fires
  console.log("\n--- Triggering UI search box ---");
  await new Promise(r => setTimeout(r, 500));

  // Type '/' to open search
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "/", text: "/", windowsVirtualKeyCode: 191 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "/", windowsVirtualKeyCode: 191 });
  await new Promise(r => setTimeout(r, 800));

  // Type query char by char
  for (const ch of QUERY) {
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: ch, text: ch });
    await client.Input.dispatchKeyEvent({ type: "char", key: ch, text: ch });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: ch });
    await new Promise(r => setTimeout(r, 80));
  }

  console.log("Query typed, waiting 3s for network...");
  const beforeSearch = captured.length;
  await new Promise(r => setTimeout(r, 3000));
  const searchRequests = captured.slice(beforeSearch);
  if (searchRequests.length > 0) {
    console.log(`UI search triggered ${searchRequests.length} request(s):`);
    searchRequests.forEach(r => console.log(" ", r.entry));
  } else {
    console.log("No network requests from UI search (all local)");
  }

  // Press Enter to submit the search (triggers server-side search)
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Return", windowsVirtualKeyCode: 13 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Return", windowsVirtualKeyCode: 13 });
  console.log("Enter pressed — waiting 5s for server search requests...");
  const beforeEnter = captured.length;
  await new Promise(r => setTimeout(r, 5000));
  const enterRequests = captured.slice(beforeEnter);
  if (enterRequests.length > 0) {
    console.log(`After Enter: ${enterRequests.length} request(s):`);
    enterRequests.forEach(r => console.log(" ", r.entry.slice(0, 300)));
  } else {
    console.log("No network requests after Enter either");
  }

  // Escape
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });

  // 7. Try portal invoke with query on various list IDs (server proxied?)
  await run("threadInternal.listAsync ALL_MAIL with query (does it hit server?)", `
    (function() {
      var portal = window.GoogleAccount && window.GoogleAccount.portal;
      if (!portal) return { error: 'no portal' };
      return portal.invoke('threadInternal', 'listAsync', ['ALL_MAIL', { limit: 5, query: ${JSON.stringify(QUERY)} }])
        .then(function(r) {
          var threads = (r && r.threads) ? r.threads : (Array.isArray(r) ? r : []);
          return { count: threads.length, sample: JSON.stringify(r).slice(0, 300) };
        }).catch(function(e) { return { error: e.message }; });
    })()
  `);

  // 8. Check if the backend has a method specifically for thread search
  await run("All backend methods containing 'thread' or 'search'", `
    (function() {
      var backend = window.GoogleAccount && window.GoogleAccount.backend;
      if (!backend) return {};
      var all = new Set();
      var obj = backend;
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) { all.add(k); });
        obj = Object.getPrototypeOf(obj);
      }
      return {
        threadMethods: Array.from(all).filter(function(k) { return /thread/i.test(k); }),
        searchMethods: Array.from(all).filter(function(k) { return /search|query|find/i.test(k); }),
      };
    })()
  `);

  console.log("\n=== ALL captured requests this session ===");
  captured.forEach(c => console.log(`[${new Date(c.time).toISOString().slice(11,23)}]`, c.entry.slice(0, 300)));

  await client.close();
}

main().catch(console.error);
