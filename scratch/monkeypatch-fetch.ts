import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const offscreen = targets.find(t => t.url.includes("offscreen_page.html"))!;

const swClient = await CDP({ port: PORT, target: sw.id });
const offClient = await CDP({ port: PORT, target: offscreen.id });

// Monkey-patch fetch on BOTH contexts
for (const [client, label] of [[swClient, "SW"], [offClient, "offscreen"]] as const) {
  await client.Runtime.evaluate({
    expression: `
      (() => {
        if (window.__origFetch) return "already patched";
        window.__origFetch = self.fetch;
        window.__capturedTokens = [];
        self.fetch = async function(...args) {
          const [input, init] = args;
          const url = typeof input === "string" ? input : input?.url || "";
          if (url.includes("superhuman.com")) {
            let auth = "";
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                auth = init.headers.get("Authorization") || "";
              } else if (typeof init.headers === "object") {
                auth = init.headers["Authorization"] || init.headers["authorization"] || "";
              }
            }
            if (auth.startsWith("Bearer ")) {
              window.__capturedTokens.push({
                url: url.slice(0, 100),
                token: auth.slice(7),
                time: Date.now(),
              });
            }
          }
          return window.__origFetch.apply(this, args);
        };
        return "patched";
      })()
    `,
    returnByValue: true,
  });
  console.log(`${label}: fetch patched`);
}

// Force ehu to make backend API calls
console.log("\nTriggering ehu@law.virginia.edu sync...");
await swClient.Runtime.evaluate({
  expression: `(async () => {
    const bg = backgrounds["ehu@law.virginia.edu"]._accountBackground;
    bg.stopSyncPoller();
    await new Promise(r => setTimeout(r, 500));
    bg.startSyncPoller();
    // Also try explicit requests
    try { await bg.requestBackground("sync", {}); } catch(e) {}
    try { await bg.requestBackground("users.refreshAliases", {}); } catch(e) {}
  })()`,
  awaitPromise: true,
});

console.log("Waiting 10 seconds...");
await new Promise(r => setTimeout(r, 10000));

// Collect captured tokens from both contexts
for (const [client, label] of [[swClient, "SW"], [offClient, "offscreen"]] as const) {
  const r = await client.Runtime.evaluate({
    expression: `JSON.stringify(window.__capturedTokens || [])`,
    returnByValue: true,
  });
  const tokens = JSON.parse(r.result.value as string);
  console.log(`\n${label}: ${tokens.length} captured requests`);

  // Deduplicate by token
  const seen = new Set<string>();
  for (const t of tokens) {
    const key = t.token.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);

    console.log(`  URL: ${t.url}`);
    try {
      const payload = JSON.parse(Buffer.from(t.token.split(".")[1], "base64url").toString());
      console.log(`  iss: ${payload.iss}`);
      console.log(`  sub: ${payload.sub}`);
      console.log(`  email: ${payload.email || "(none)"}`);
      console.log(`  aud: ${payload.aud}`);

      // Test snippet API
      const resp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8", Authorization: "Bearer " + t.token },
        body: JSON.stringify({ filter: { type: "snippet" }, offset: 0, limit: 100 }),
      });
      console.log(`  Snippet API: ${resp.status}`);
      if (resp.ok) {
        const data = (await resp.json()) as any;
        let count = 0;
        for (const thread of (data.threads || [])) {
          for (const m of (thread.messages || [])) {
            if (m.draft?.action === "snippet") {
              count++;
              console.log(`    -> "${m.draft.name}"`);
            }
          }
        }
        console.log(`  Snippets: ${count}`);
      }
    } catch (e) {
      console.log(`  JWT decode error: ${(e as Error).message}`);
    }
    console.log();
  }

  // Cleanup
  await client.Runtime.evaluate({
    expression: `self.fetch = window.__origFetch; delete window.__origFetch; delete window.__capturedTokens;`,
  });
}

await swClient.close();
await offClient.close();
