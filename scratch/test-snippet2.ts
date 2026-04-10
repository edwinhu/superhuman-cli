import CDP from "chrome-remote-interface";

const targets = await CDP.List({ port: 9400 });
const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker");
if (!sw) { console.log("No service worker found"); process.exit(1); }

const client = await CDP({ port: 9400, target: sw.id });
const { Fetch: FetchDomain, Runtime } = client;

// Step 1: Use Fetch domain to intercept and capture auth from ANY request
await FetchDomain.enable({ patterns: [{ urlPattern: "*" }] });

const tokens: Record<string, string> = {};
FetchDomain.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  if (auth.startsWith("Bearer ")) {
    const t = auth.slice(7);
    // Use first 20 chars as key to deduplicate
    const key = t.slice(0, 20);
    if (!tokens[key]) {
      tokens[key] = t;
      console.log("  Token from:", request.url.slice(0, 80));
    }
  }
  await FetchDomain.continueRequest({ requestId });
});

// Step 2: Force Superhuman to make API calls by navigating the main page
console.log("Waiting for organic API traffic (use Superhuman in browser)...");

// Try to force sync on both accounts
await Runtime.evaluate({
  expression: `(async () => {
    for (const email of Object.keys(backgrounds)) {
      const bg = backgrounds[email]._accountBackground;
      try {
        // Try different methods to trigger network calls
        bg.startSyncPoller();
      } catch(e) {}
    }
  })()`,
  awaitPromise: true,
});

await new Promise(r => setTimeout(r, 10000));

await FetchDomain.disable();

const uniqueTokens = Object.values(tokens);
console.log("\nCaptured", uniqueTokens.length, "unique tokens");

for (const token of uniqueTokens) {
  // Decode JWT
  const parts = token.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
      console.log("\n--- Account:", payload.email || payload.sub);
      console.log("    Exp:", new Date(payload.exp * 1000).toISOString());

      // Test snippet API with this token
      const resp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8", "Authorization": "Bearer " + token },
        body: JSON.stringify({ filter: { type: "snippet" }, offset: 0, limit: 100 }),
      });
      console.log("    Snippet API:", resp.status);
      if (resp.ok) {
        const data = (await resp.json()) as any;
        const threads = data.threads || [];
        let count = 0;
        for (const t of threads) {
          for (const m of t.messages || []) {
            if (m.draft?.action === "snippet") {
              count++;
              console.log("    ->", m.draft.name);
            }
          }
        }
        if (count === 0) console.log("    No snippets in this account");
      } else {
        const text = await resp.text();
        console.log("    Error:", text.slice(0, 100));
      }
    } catch (e) {
      console.log("    JWT decode error:", (e as Error).message);
    }
  }
}

await client.close();
