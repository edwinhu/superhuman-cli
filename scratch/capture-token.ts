import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker");
if (!sw) { console.log("No Superhuman service worker found"); process.exit(1); }

const client = await CDP({ port: PORT, target: sw.id });
const { Fetch: FetchDomain, Runtime } = client;

// Enable Fetch interception for all superhuman backend calls
await FetchDomain.enable({ patterns: [{ urlPattern: "*superhuman.com*" }] });

const tokensByEmail: Record<string, string> = {};

FetchDomain.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      const email = payload.email || payload.sub || "unknown";
      if (!tokensByEmail[email]) {
        tokensByEmail[email] = token;
        console.log(`  Captured token for: ${email}`);
      }
    } catch {
      // Not a JWT or decode failed
    }
  }
  await FetchDomain.continueRequest({ requestId });
});

// Force sync poller restart to trigger fresh API calls
console.log("Forcing sync restart...");
await Runtime.evaluate({
  expression: `(async () => {
    for (const email of Object.keys(backgrounds)) {
      const bg = backgrounds[email]._accountBackground;
      try { bg.stopSyncPoller(); } catch(e) {}
      try { bg.startSyncPoller(); } catch(e) {}
    }
  })()`,
  awaitPromise: true,
});

// Wait for requests to come through
console.log("Waiting 15 seconds for API traffic...");
await new Promise(r => setTimeout(r, 15000));

await FetchDomain.disable();

const emails = Object.keys(tokensByEmail);
console.log(`\nCaptured tokens for ${emails.length} account(s)`);

for (const email of emails) {
  const token = tokensByEmail[email];
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  console.log(`\n=== ${email} ===`);
  console.log(`  Expires: ${new Date(payload.exp * 1000).toISOString()}`);

  // Test snippet API
  const resp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", "Authorization": "Bearer " + token },
    body: JSON.stringify({ filter: { type: "snippet" }, offset: 0, limit: 100 }),
  });

  if (resp.ok) {
    const data = (await resp.json()) as any;
    const threads = data.threads || [];
    let count = 0;
    for (const t of threads) {
      for (const m of t.messages || []) {
        if (m.draft?.action === "snippet") {
          count++;
          console.log(`  Snippet: "${m.draft.name}" (${m.draft.snippetAnalytics?.sends || 0} sends)`);
        }
      }
    }
    console.log(`  Total snippets: ${count}`);
  } else {
    console.log(`  API error: ${resp.status} ${await resp.text()}`);
  }
}

await client.close();
