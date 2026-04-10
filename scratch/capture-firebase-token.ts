import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const offscreen = targets.find(t => t.url.includes("offscreen_page.html"))!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const offClient = await CDP({ port: PORT, target: offscreen.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

// Intercept ALL network on ALL contexts
const allTokens: Array<{ source: string; url: string; token: string; payload: any }> = [];

async function setupCapture(client: any, label: string) {
  await client.Fetch.enable({ patterns: [{ urlPattern: "*" }] });
  client.Fetch.requestPaused(async ({ requestId, request }: any) => {
    const auth = request.headers["Authorization"] || "";
    if (auth.startsWith("Bearer ") && request.url.includes("superhuman")) {
      const token = auth.slice(7);
      try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
        allTokens.push({ source: label, url: request.url, token, payload });
      } catch {}
    }
    // Also check for Firebase-specific endpoints
    if (request.url.includes("securetoken.googleapis.com") ||
        request.url.includes("identitytoolkit.googleapis.com") ||
        request.url.includes("firebase")) {
      console.log(`  [${label}] Firebase request: ${request.url.slice(0, 100)}`);
    }
    await client.Fetch.continueRequest({ requestId });
  });
}

await setupCapture(swClient, "SW");
await setupCapture(offClient, "offscreen");
await setupCapture(mainClient, "main");

// Force re-auth by stopping and restarting the ehu background
console.log("Restarting ehu@law.virginia.edu background...");
await swClient.Runtime.evaluate({
  expression: `(async () => {
    const bg = backgrounds["ehu@law.virginia.edu"]._accountBackground;
    bg.stop();
    await new Promise(r => setTimeout(r, 1000));
    bg.start();
  })()`,
  awaitPromise: true,
});

console.log("Waiting 15 seconds...");
await new Promise(r => setTimeout(r, 15000));

// Disable all interceptors
await swClient.Fetch.disable().catch(() => {});
await offClient.Fetch.disable().catch(() => {});
await mainClient.Fetch.disable().catch(() => {});

// Deduplicate tokens
const uniqueTokens = new Map<string, typeof allTokens[0]>();
for (const t of allTokens) {
  const key = `${t.payload.iss}|${t.payload.sub}`;
  if (!uniqueTokens.has(key)) uniqueTokens.set(key, t);
}

console.log(`\nTotal captured: ${allTokens.length}, Unique: ${uniqueTokens.size}\n`);

for (const [key, t] of uniqueTokens) {
  console.log(`=== ${t.source}: ${t.payload.email || t.payload.sub} ===`);
  console.log(`  iss: ${t.payload.iss}`);
  console.log(`  aud: ${t.payload.aud}`);
  console.log(`  exp: ${new Date(t.payload.exp * 1000).toISOString()}`);
  console.log(`  URL: ${t.url.slice(0, 80)}`);

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
  } else {
    const text = await resp.text();
    console.log(`  Error: ${text.slice(0, 200)}`);
  }
  console.log();
}

await swClient.close();
await offClient.close();
await mainClient.close();
