import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

const { Fetch: SwFetch } = swClient;
await SwFetch.enable({ patterns: [{ urlPattern: "*superhuman.com/~backend/v3*" }] });

// Collect tokens keyed by x-superhuman-user-email
const tokensByEmail: Record<string, { token: string; url: string }> = {};

SwFetch.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  const email = request.headers["x-superhuman-user-email"] || "";
  if (auth.startsWith("Bearer ") && email) {
    if (!tokensByEmail[email]) {
      tokensByEmail[email] = { token: auth.slice(7), url: request.url };
      console.log(`  Captured token for ${email} from ${request.url.split("/").pop()}`);
    }
  }
  await SwFetch.continueRequest({ requestId });
});

console.log("Reloading Superhuman page...");
await mainClient.Page.reload();

console.log("Waiting 20 seconds...");
await new Promise(r => setTimeout(r, 20000));

await SwFetch.disable();

console.log(`\nCaptured tokens for ${Object.keys(tokensByEmail).length} account(s)\n`);

for (const [email, { token, url }] of Object.entries(tokensByEmail)) {
  console.log(`=== ${email} ===`);
  console.log(`  From: ${url.split("/").pop()}`);

  // Decode JWT
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    console.log(`  JWT sub: ${payload.sub}`);
    console.log(`  JWT email: ${payload.email || "(none)"}`);
    console.log(`  JWT iss: ${payload.iss}`);
    console.log(`  JWT exp: ${new Date(payload.exp * 1000).toISOString()}`);
  } catch (e) {
    console.log(`  JWT decode failed: ${(e as Error).message}`);
  }

  // Test snippet API
  const resp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "Authorization": "Bearer " + token,
    },
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
    console.log(`  Error body: ${text.slice(0, 200)}`);
  }
  console.log();
}

await mainClient.close();
await swClient.close();
