import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

const { Fetch: SwFetch } = swClient;
await SwFetch.enable({ patterns: [{ urlPattern: "*superhuman.com*" }] });

// Capture ALL tokens with their endpoint
const allCaptures: Array<{ email: string; endpoint: string; token: string; iss: string }> = [];

SwFetch.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  const email = request.headers["x-superhuman-user-email"] || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const endpoint = request.url.replace("https://mail.superhuman.com/~backend/", "");
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      allCaptures.push({ email, endpoint, token, iss: payload.iss || "unknown" });
    } catch {}
  }
  await SwFetch.continueRequest({ requestId });
});

// Make sure we're on the ehu account and reload
console.log("Navigating to ehu@law.virginia.edu...");
await mainClient.Page.navigate({ url: "https://mail.superhuman.com/ehu@law.virginia.edu" });
await new Promise(r => setTimeout(r, 3000));

console.log("Reloading...");
await mainClient.Page.reload();

console.log("Waiting 20 seconds...");
await new Promise(r => setTimeout(r, 20000));

await SwFetch.disable();

// Group by token issuer
const byIss: Record<string, typeof allCaptures> = {};
for (const c of allCaptures) {
  const key = `${c.email}|${c.iss}`;
  if (!byIss[key]) byIss[key] = [];
  byIss[key].push(c);
}

console.log(`\nTotal requests: ${allCaptures.length}`);
console.log(`Token groups: ${Object.keys(byIss).length}\n`);

for (const [key, captures] of Object.entries(byIss)) {
  const first = captures[0];
  console.log(`=== ${first.email} | iss: ${first.iss} ===`);
  console.log(`  Used for: ${[...new Set(captures.map(c => c.endpoint))].join(", ")}`);

  const payload = JSON.parse(Buffer.from(first.token.split(".")[1], "base64url").toString());
  console.log(`  JWT sub: ${payload.sub}`);
  console.log(`  JWT exp: ${new Date(payload.exp * 1000).toISOString()}`);

  // Test snippet API
  const resp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", Authorization: "Bearer " + first.token },
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
    if (count === 0 && data.threads?.length) {
      console.log(`  (${data.threads.length} threads returned but none are snippets)`);
    }
  } else {
    const text = await resp.text();
    console.log(`  Error: ${text.slice(0, 200)}`);
  }
  console.log();
}

await swClient.close();
await mainClient.close();
