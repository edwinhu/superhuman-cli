#!/usr/bin/env bun
/**
 * Capture network requests when Superhuman performs a keyword search.
 * Run this, then perform a search in the Superhuman app to identify the backend endpoint.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = parseInt(process.env.CDP_PORT || "9250");

async function main() {
  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  console.log(`Found ${targets.length} CDP targets on port ${CDP_PORT}\n`);

  const clients: any[] = [];

  for (const target of targets) {
    if (!target.url || target.url === "about:blank") continue;

    const label = `${target.type}:${target.url.substring(0, 70)}`;

    try {
      const client = await CDP({ host, port: CDP_PORT, target: target.id });
      const { Network } = client;
      await Network.enable({ maxPostDataSize: 65536 });

      Network.requestWillBeSent((params: any) => {
        const url: string = params.request.url;
        const method: string = params.request.method;

        // Capture ALL superhuman.com requests (not just writes)
        if (!url.includes("superhuman.com")) return;

        // Skip static assets
        if (url.match(/\.(js|css|png|jpg|svg|woff|ico|woff2)(\?|$)/)) return;

        console.log(`\n[${label}]`);
        console.log(`  ${method} ${url}`);

        const body = params.request.postData;
        if (body) {
          try {
            const parsed = JSON.parse(body);
            console.log("  Body:", JSON.stringify(parsed, null, 2).slice(0, 2000));
          } catch {
            console.log("  Body:", body.slice(0, 1000));
          }
        }

        const headers = params.request.headers;
        if (headers?.Authorization) {
          console.log("  Auth:", headers.Authorization.slice(0, 40) + "...");
        }
      });

      // Also capture responses to see what comes back
      Network.responseReceived((params: any) => {
        const url: string = params.response.url;
        if (!url.includes("superhuman.com")) return;
        if (url.match(/\.(js|css|png|jpg|svg|woff|ico|woff2)(\?|$)/)) return;

        console.log(`  → Response ${params.response.status} for ${url.slice(0, 100)}`);
      });

      clients.push(client);
      console.log(`Monitoring: ${label}`);
    } catch (e: any) {
      console.log(`Skip: ${e.message?.substring(0, 80)}`);
    }
  }

  console.log(`\n=== Monitoring ${clients.length} targets ===`);
  console.log("Now perform a KEYWORD SEARCH in the Superhuman app.");
  console.log("Look for any requests containing 'search', 'query', 'find', etc.");
  console.log("Press Ctrl+C to stop.\n");

  process.on("SIGINT", async () => {
    for (const c of clients) await c.close().catch(() => {});
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(console.error);
