import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const { Fetch: SwFetch, Runtime } = swClient;

// Set up interception
await SwFetch.enable({ patterns: [{ urlPattern: "*superhuman.com*" }] });

const tokensByEmail: Record<string, string> = {};
SwFetch.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  const email = request.headers["x-superhuman-user-email"] || "";
  if (auth.startsWith("Bearer ") && email && !tokensByEmail[email]) {
    tokensByEmail[email] = auth.slice(7);
    console.log(`  Captured: ${email}`);
  }
  await SwFetch.continueRequest({ requestId });
});

// Force the eddyhu account to make an API call by calling requestBackground
// with something that requires a fresh network request
console.log("Forcing eddyhu@gmail.com to make API call...");

const r = await Runtime.evaluate({
  expression: `(async () => {
    const bg = backgrounds["eddyhu@gmail.com"]._accountBackground;
    // Try getting labels which should force a network call
    try {
      const result = await bg.requestBackground("labels.resync", {});
      return JSON.stringify({ success: true, result: String(result).slice(0, 100) });
    } catch(e) {
      return JSON.stringify({ error: e.message });
    }
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log("requestBackground result:", r.result.value);

await new Promise(r => setTimeout(r, 5000));

// Try another approach - call sync directly
const r2 = await Runtime.evaluate({
  expression: `(async () => {
    const bg = backgrounds["eddyhu@gmail.com"]._accountBackground;
    try {
      const result = await bg.requestBackground("users.refreshAliases", {});
      return JSON.stringify({ success: true });
    } catch(e) {
      return JSON.stringify({ error: e.message });
    }
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log("refreshAliases result:", r2.result.value);

await new Promise(r => setTimeout(r, 5000));

await SwFetch.disable();

console.log(`\nTokens captured: ${Object.keys(tokensByEmail).length}`);
for (const [email, token] of Object.entries(tokensByEmail)) {
  console.log(`\n=== ${email} ===`);
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    console.log(`  sub: ${payload.sub}`);
    console.log(`  iss: ${payload.iss}`);
    console.log(`  exp: ${new Date(payload.exp * 1000).toISOString()}`);
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
    console.log(`  Error: ${await resp.text()}`);
  }
}

await swClient.close();
