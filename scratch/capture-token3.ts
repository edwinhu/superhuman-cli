import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

// Set up interception on the service worker
const { Fetch: SwFetch } = swClient;
await SwFetch.enable({ patterns: [{ urlPattern: "*" }] });

const tokensByEmail: Record<string, string> = {};
SwFetch.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      const email = payload.email || payload.sub || "unknown";
      if (!tokensByEmail[email]) {
        tokensByEmail[email] = token;
        console.log(`  Token captured for: ${email}`);
      }
    } catch {}
  }
  await SwFetch.continueRequest({ requestId });
});

// Force a page reload to trigger fresh API calls
console.log("Reloading Superhuman page to force API calls...");
await mainClient.Page.reload();

console.log("Waiting 15 seconds for API traffic...");
await new Promise(r => setTimeout(r, 15000));

await SwFetch.disable();

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
    headers: { "Content-Type": "text/plain;charset=UTF-8", Authorization: "Bearer " + token },
    body: JSON.stringify({ filter: { type: "snippet" }, offset: 0, limit: 100 }),
  });

  if (resp.ok) {
    const data = (await resp.json()) as any;
    let count = 0;
    for (const t of (data.threads || [])) {
      for (const m of (t.messages || [])) {
        if (m.draft?.action === "snippet") {
          count++;
          console.log(`  Snippet: "${m.draft.name}" (${m.draft.snippetAnalytics?.sends || 0} sends)`);
        }
      }
    }
    console.log(`  Total snippets: ${count}`);
  } else {
    console.log(`  API error: ${resp.status}`);
  }
}

await mainClient.close();
await swClient.close();
