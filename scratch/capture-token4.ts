import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

const { Fetch: SwFetch } = swClient;
await SwFetch.enable({ patterns: [{ urlPattern: "*superhuman.com*" }] });

// Collect ALL tokens with their associated URL
const allCaptures: Array<{ url: string; token: string; email?: string }> = [];

SwFetch.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      allCaptures.push({
        url: request.url,
        token,
        email: payload.email || payload.sub,
      });
    } catch {}
  }
  await SwFetch.continueRequest({ requestId });
});

console.log("Reloading Superhuman...");
await mainClient.Page.reload();
await new Promise(r => setTimeout(r, 15000));
await SwFetch.disable();

// Deduplicate by token prefix
const seen = new Set<string>();
const unique: typeof allCaptures = [];
for (const c of allCaptures) {
  const key = c.token.slice(0, 40);
  if (!seen.has(key)) {
    seen.add(key);
    unique.push(c);
  }
}

console.log(`\nCaptured ${unique.length} unique tokens from ${allCaptures.length} requests\n`);

for (const c of unique) {
  const payload = JSON.parse(Buffer.from(c.token.split(".")[1], "base64url").toString());
  console.log("=== Token ===");
  console.log("  URL:", c.url.slice(0, 100));
  console.log("  JWT payload keys:", Object.keys(payload).join(", "));
  console.log("  sub:", payload.sub);
  console.log("  email:", payload.email);
  console.log("  aud:", payload.aud);
  console.log("  iss:", payload.iss);
  console.log("  exp:", new Date(payload.exp * 1000).toISOString());

  // Try snippet API
  const resp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", Authorization: "Bearer " + c.token },
    body: JSON.stringify({ filter: { type: "snippet" }, offset: 0, limit: 100 }),
  });
  console.log("  Snippet API:", resp.status);
  if (resp.ok) {
    const data = (await resp.json()) as any;
    let count = 0;
    for (const t of (data.threads || [])) {
      for (const m of (t.messages || [])) {
        if (m.draft?.action === "snippet") {
          count++;
          console.log(`    -> "${m.draft.name}"`);
        }
      }
    }
    console.log(`  Snippets: ${count}`);
  }
  console.log();
}

await mainClient.close();
await swClient.close();
