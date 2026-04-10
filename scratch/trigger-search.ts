#!/usr/bin/env bun
/**
 * Trigger Superhuman's internal search and capture the backend API calls.
 * Monitors network traffic while calling ga.threads.search() via CDP Runtime.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = parseInt(process.env.CDP_PORT || "9250");
const QUERY = process.argv[2] || "test";

async function main() {
  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });

  // Monitor ALL targets for network traffic
  const monitors: any[] = [];
  const captured: string[] = [];

  for (const target of targets) {
    if (!target.url || target.url === "about:blank") continue;
    try {
      const client = await CDP({ host, port: CDP_PORT, target: target.id });
      await client.Network.enable({ maxPostDataSize: 65536 });

      client.Network.requestWillBeSent((params: any) => {
        const url: string = params.request.url;
        const method: string = params.request.method;
        if (!url.includes("superhuman.com")) return;
        if (url.match(/\.(js|css|png|jpg|svg|woff|ico|woff2)(\?|$)/)) return;

        const entry = `[${target.type}] ${method} ${url}`;
        const body = params.request.postData;
        const full = body ? `${entry}\n  Body: ${body.slice(0, 500)}` : entry;
        captured.push(full);
        console.log(full);
      });

      monitors.push(client);
    } catch {}
  }

  console.log(`Monitoring ${monitors.length} targets...\n`);

  // Find the Superhuman page to trigger search via Runtime.evaluate
  const shTarget = targets.find(t =>
    t.url.includes("mail.superhuman.com") && t.type === "page"
  );
  const swTarget = targets.find(t =>
    t.url.includes("background") && t.type === "service_worker"
  );

  const execTarget = shTarget || swTarget;
  if (!execTarget) {
    console.error("No Superhuman page found to run eval in");
    process.exit(1);
  }

  console.log(`Executing in: ${execTarget.url.slice(0, 80)}\n`);

  const execClient = await CDP({ host, port: CDP_PORT, target: execTarget.id });

  // Wait a moment for monitors to settle
  await new Promise(r => setTimeout(r, 500));

  // Try multiple search approaches to find which one hits the backend
  const approaches = [
    // 1. ga.threads.search()
    `(async () => {
      const ga = window.GoogleAccount;
      const threads = ga?.threads;
      if (typeof threads?.search === 'function') {
        const result = threads.search(${JSON.stringify(QUERY)}, { limit: 5 });
        return { method: 'ga.threads.search', result: JSON.stringify(result)?.slice(0, 500) };
      }
      return { method: 'ga.threads.search', error: 'not a function' };
    })()`,

    // 2. portal invoke on 'search' service
    `(async () => {
      const ga = window.GoogleAccount;
      const portal = ga?.portal;
      if (!portal) return { method: 'portal.search', error: 'no portal' };
      try {
        const result = await portal.invoke('search', 'search', [{ query: ${JSON.stringify(QUERY)}, limit: 5 }]);
        return { method: 'portal.search.search', result: JSON.stringify(result)?.slice(0, 500) };
      } catch(e) {
        return { method: 'portal.search.search', error: e.message };
      }
    })()`,

    // 3. Check what search-related services exist in DI
    `(async () => {
      const ga = window.GoogleAccount;
      const portal = ga?.portal;
      if (!portal) return { method: 'di.inspect', error: 'no portal' };
      try {
        // Look for a search DI service
        const di = portal._di || portal.di || portal._container || portal.container;
        if (!di) return { method: 'di.inspect', error: 'no DI container' };
        const searchSvc = di.get?.('search') || di.get?.('Search') || di.get?.('threadSearch');
        return {
          method: 'di.inspect',
          searchSvcType: typeof searchSvc,
          searchSvcKeys: searchSvc ? Object.keys(searchSvc).join(',').slice(0, 200) : null
        };
      } catch(e) {
        return { method: 'di.inspect', error: e.message };
      }
    })()`,

    // 4. Try ai.semanticSearchProxy which might do text search
    `(async () => {
      const token = window.GoogleAccount?.backend?._token || window.GoogleAccount?.superhumanToken;
      if (!token) return { method: 'semanticSearch', error: 'no token' };
      try {
        const r = await fetch('/~backend/v3/ai.semanticSearchProxy.user/test?query=' + encodeURIComponent(${JSON.stringify(QUERY)}), {
          headers: { Authorization: 'Bearer ' + token }
        });
        const text = await r.text();
        return { method: 'semanticSearch', status: r.status, body: text.slice(0, 300) };
      } catch(e) {
        return { method: 'semanticSearch', error: e.message };
      }
    })()`,
  ];

  for (const expr of approaches) {
    console.log("\n--- Trying approach ---");
    try {
      const result = await execClient.Runtime.evaluate({
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        timeout: 10000,
      });
      if (result.exceptionDetails) {
        console.log("Exception:", result.exceptionDetails.text);
      } else {
        console.log("Result:", JSON.stringify(result.result?.value, null, 2));
      }
    } catch (e: any) {
      console.log("Error:", e.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log("\n=== Summary of captured network requests ===");
  console.log(`Total captured: ${captured.length}`);
  for (const c of captured) console.log(c);

  for (const m of monitors) await m.close().catch(() => {});
  await execClient.close().catch(() => {});
}

main().catch(console.error);
