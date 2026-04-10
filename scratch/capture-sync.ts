import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const offscreen = targets.find(t => t.url.includes("offscreen_page.html"))!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const offClient = await CDP({ port: PORT, target: offscreen.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

// Intercept on ALL three contexts simultaneously
const tokensByEmail: Record<string, string> = {};

async function setupInterception(client: any, label: string) {
  await client.Fetch.enable({ patterns: [{ urlPattern: "*superhuman.com*" }] });
  client.Fetch.requestPaused(async ({ requestId, request }: any) => {
    const auth = request.headers["Authorization"] || "";
    const email = request.headers["x-superhuman-user-email"] || "";
    if (auth.startsWith("Bearer ") && email && !tokensByEmail[email]) {
      tokensByEmail[email] = auth.slice(7);
      console.log(`  [${label}] Captured: ${email}`);
    }
    await client.Fetch.continueRequest({ requestId });
  });
}

await setupInterception(swClient, "SW");
await setupInterception(offClient, "offscreen");
await setupInterception(mainClient, "main");

// Force full resync for eddyhu by restarting its background
console.log("Restarting eddyhu background + reloading page...");

await swClient.Runtime.evaluate({
  expression: `(async () => {
    const bg = backgrounds["eddyhu@gmail.com"]._accountBackground;
    // Stop and restart sync poller to trigger fresh network sync
    bg.stopSyncPoller();
    // Small delay then restart
    await new Promise(r => setTimeout(r, 500));
    bg.startSyncPoller();
    // Also try explicit sync
    bg.requestBackground("sync", {});
    bg.requestBackground("userdata.sync", {});
  })()`,
  awaitPromise: true,
});

// Also reload the page to trigger foreground init
await mainClient.Page.reload();

console.log("Waiting 20 seconds for network traffic...");
await new Promise(r => setTimeout(r, 20000));

// Disable all
await swClient.Fetch.disable().catch(() => {});
await offClient.Fetch.disable().catch(() => {});
await mainClient.Fetch.disable().catch(() => {});

console.log(`\nTokens: ${Object.keys(tokensByEmail).length}`);
for (const [email, token] of Object.entries(tokensByEmail)) {
  console.log(`\n=== ${email} ===`);
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    console.log(`  JWT iss: ${payload.iss}`);
    console.log(`  JWT exp: ${new Date(payload.exp * 1000).toISOString()}`);
  } catch {}

  const resp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", Authorization: "Bearer " + token },
    body: JSON.stringify({ filter: { type: "snippet" }, offset: 0, limit: 100 }),
  });
  console.log(`  Snippet API: ${resp.status}`);
  if (resp.ok) {
    const data = (await resp.json()) as any;
    let count = 0;
    for (const t of (data.threads || [])) {
      for (const m of (t.messages || [])) {
        if (m.draft?.action === "snippet") {
          count++;
          console.log(`    -> "${m.draft.name}" (${m.draft.snippetAnalytics?.sends || 0} sends)`);
        }
      }
    }
    console.log(`  Snippets: ${count}`);
  } else {
    const text = await resp.text();
    console.log(`  Error: ${text.slice(0, 200)}`);
  }
}

await swClient.close();
await offClient.close();
await mainClient.close();
