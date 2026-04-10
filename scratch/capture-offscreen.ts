import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

// The offscreen page handles background account API calls
const offscreen = targets.find(t => t.url.includes("offscreen_page.html"))!;
const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;

console.log("Connecting to offscreen page:", offscreen.url.slice(0, 60));

const offClient = await CDP({ port: PORT, target: offscreen.id });
const swClient = await CDP({ port: PORT, target: sw.id });

// Intercept on the offscreen page
const { Fetch: OffFetch } = offClient;
await OffFetch.enable({ patterns: [{ urlPattern: "*superhuman.com*" }] });

const tokensByEmail: Record<string, string> = {};
OffFetch.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  const email = request.headers["x-superhuman-user-email"] || "";
  if (auth.startsWith("Bearer ")) {
    if (email && !tokensByEmail[email]) {
      tokensByEmail[email] = auth.slice(7);
      console.log(`  Captured: ${email} from ${request.url.split("/").pop()}`);
    }
  }
  await OffFetch.continueRequest({ requestId });
});

// Force eddyhu to make API calls
console.log("Triggering eddyhu API calls...");
await swClient.Runtime.evaluate({
  expression: `(async () => {
    const bg = backgrounds["eddyhu@gmail.com"]._accountBackground;
    await bg.requestBackground("users.refreshAliases", {});
    await bg.requestBackground("labels.resync", {});
  })()`,
  awaitPromise: true,
});

console.log("Waiting 10 seconds...");
await new Promise(r => setTimeout(r, 10000));

await OffFetch.disable();

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

await offClient.close();
await swClient.close();
