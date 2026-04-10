#!/usr/bin/env bun
/**
 * Monitor ALL CDP targets for ANY POST/PUT/PATCH requests.
 * No URL filtering - capture everything to find where attachment traffic goes.
 */

import CDP from "chrome-remote-interface";

async function main() {
  const targets = await CDP.List({ port: 9400 });
  console.log(`Found ${targets.length} targets\n`);

  const clients: any[] = [];

  for (const target of targets) {
    // Skip workers that have no URL (shared workers)
    if (!target.url || target.url === "") continue;
    // Skip about:blank
    if (target.url === "about:blank") continue;

    const label = `${target.type}:${target.url.substring(0, 60)}`;

    try {
      const client = await CDP({ port: 9400, target: target.id });
      const { Network } = client;
      await Network.enable();

      Network.requestWillBeSent((params: any) => {
        const method = params.request.method;
        const url: string = params.request.url;

        // Only log POST/PUT/PATCH (writes) OR writeMessage/send/draft/attach keywords
        const isWrite = method === "POST" || method === "PUT" || method === "PATCH";
        const hasKeyword = url.includes("draft") || url.includes("send") || url.includes("attach") || url.includes("upload") || url.includes("writeMessage");

        if (isWrite || hasKeyword) {
          console.log(`\n[${label}] ${method} ${url}`);
          if (params.request.postData) {
            const data = params.request.postData;
            if (data.length > 5000) {
              console.log(`  Body (${data.length} chars): ${data.substring(0, 2000)}...`);
            } else {
              try {
                console.log(`  Body: ${JSON.stringify(JSON.parse(data), null, 2)}`);
              } catch {
                console.log(`  Body: ${data.substring(0, 2000)}`);
              }
            }
          }
        }
      });

      clients.push(client);
      console.log(`Monitoring: ${label}`);
    } catch (e: any) {
      console.log(`Skip ${label}: ${e.message?.substring(0, 50)}`);
    }
  }

  console.log(`\n=== Monitoring ${clients.length} targets for POST/PUT/PATCH ===`);
  console.log("Attach a file in Superhuman now. Press Ctrl+C to stop.\n");

  process.on("SIGINT", async () => {
    for (const c of clients) await c.close().catch(() => {});
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

main().catch(console.error);
