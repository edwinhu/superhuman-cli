import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

// Set up interception on service worker (foreground account's API calls go here)
const { Fetch: SwFetch } = swClient;
await SwFetch.enable({ patterns: [{ urlPattern: "*superhuman.com*" }] });

const tokensByEmail: Record<string, string> = {};
SwFetch.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  const email = request.headers["x-superhuman-user-email"] || "";
  if (auth.startsWith("Bearer ") && email && !tokensByEmail[email]) {
    tokensByEmail[email] = auth.slice(7);
    console.log(`  Captured: ${email} from ${request.url.split("/").pop()}`);
  }
  await SwFetch.continueRequest({ requestId });
});

// Switch to eddyhu@gmail.com by navigating
console.log("Switching to eddyhu@gmail.com...");
await mainClient.Page.navigate({ url: "https://mail.superhuman.com/eddyhu@gmail.com" });

console.log("Waiting 15 seconds for API traffic...");
await new Promise(r => setTimeout(r, 15000));

await SwFetch.disable();

console.log(`\nTokens: ${Object.keys(tokensByEmail).length}`);
for (const [email, token] of Object.entries(tokensByEmail)) {
  console.log(`\n=== ${email} ===`);
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    console.log(`  JWT sub: ${payload.sub}`);
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

// Switch back to ehu
console.log("\nSwitching back to ehu@law.virginia.edu...");
await mainClient.Page.navigate({ url: "https://mail.superhuman.com/ehu@law.virginia.edu" });

await swClient.close();
await mainClient.close();
