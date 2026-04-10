import CDP from "chrome-remote-interface";

const targets = await CDP.List({ port: 9400 });
const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker");
if (!sw) { console.log("No service worker found"); process.exit(1); }

const client = await CDP({ port: 9400, target: sw.id });
const { Fetch: FetchDomain, Runtime } = client;

await FetchDomain.enable({ patterns: [{ urlPattern: "*superhuman.com*" }] });

let token: string | null = null;
FetchDomain.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  if (auth.startsWith("Bearer ") && token === null) {
    token = auth.slice(7);
    console.log("Captured token from:", request.url.slice(0, 80));
  }
  await FetchDomain.continueRequest({ requestId });
});

// Trigger a sync from the eddyhu account
await Runtime.evaluate({
  expression: `(async () => {
    const bg = backgrounds["eddyhu@gmail.com"]._accountBackground;
    // Force a fresh sync by requesting threads
    bg.portal.broadcast("getThreads", { filter: { type: "snippet" }, offset: 0, limit: 1 });
  })()`,
  awaitPromise: true,
});

// Also trigger by calling requestBackground
await Runtime.evaluate({
  expression: `(async () => {
    try {
      const bg = backgrounds["eddyhu@gmail.com"]._accountBackground;
      await bg.requestBackground("getThreads", { filter: { type: "snippet" }, offset: 0, limit: 1 });
    } catch(e) { console.log("requestBackground error:", e.message); }
  })()`,
  awaitPromise: true,
});

// Wait for network activity
await new Promise(r => setTimeout(r, 8000));

if (token) {
  console.log("\nToken prefix:", token.slice(0, 50));

  // Decode JWT
  const parts = token.split(".");
  if (parts.length === 3) {
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
    console.log("JWT sub:", payload.sub);
    console.log("JWT email:", payload.email);
    console.log("JWT exp:", new Date(payload.exp * 1000).toISOString());
  }

  // Test snippet API
  const resp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", "Authorization": "Bearer " + token },
    body: JSON.stringify({ filter: { type: "snippet" }, offset: 0, limit: 100 }),
  });
  console.log("\nSnippet API status:", resp.status);
  const data = (await resp.json()) as any;
  const threads = data.threads || [];
  let snippets = 0;
  for (const t of threads) {
    for (const m of t.messages || []) {
      if (m.draft?.action === "snippet") {
        snippets++;
        console.log("  Snippet:", m.draft.name, "| body:", (m.draft.body || "").slice(0, 60));
      }
    }
  }
  if (snippets === 0) {
    console.log("  No snippets found");
    console.log("  Raw:", JSON.stringify(data).slice(0, 300));
  }
} else {
  console.log("No token captured in 8 seconds");
}

await FetchDomain.disable();
await client.close();
