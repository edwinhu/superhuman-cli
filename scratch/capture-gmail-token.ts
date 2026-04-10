import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

const { Fetch: SwFetch, Runtime } = swClient;
await SwFetch.enable({ patterns: [{ urlPattern: "*superhuman.com*" }] });

// Collect ALL tokens with full details
const allCaptures: Array<{ url: string; token: string; payload: any }> = [];

SwFetch.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      allCaptures.push({ url: request.url, token, payload });
    } catch {}
  }
  await SwFetch.continueRequest({ requestId });
});

// First, switch to eddyhu@gmail.com account before reloading
console.log("Checking default account...");
const acctResult = await Runtime.evaluate({
  expression: `(async () => {
    const emails = Object.keys(backgrounds);
    return JSON.stringify(emails);
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log("Accounts:", acctResult.result.value);

console.log("Reloading Superhuman page...");
await mainClient.Page.reload();

console.log("Waiting 20 seconds for all API traffic...");
await new Promise(r => setTimeout(r, 20000));

await SwFetch.disable();

// Show ALL captured tokens
console.log(`\nTotal requests with auth: ${allCaptures.length}`);

// Deduplicate by token
const seen = new Map<string, typeof allCaptures[0]>();
for (const c of allCaptures) {
  const key = c.token.slice(0, 40);
  if (!seen.has(key)) seen.set(key, c);
}

console.log(`Unique tokens: ${seen.size}\n`);

for (const [_, c] of seen) {
  const p = c.payload;
  console.log("---");
  console.log("URL:", c.url.slice(0, 100));
  console.log("sub:", p.sub);
  console.log("email:", p.email);
  console.log("iss:", p.iss);
  console.log("aud:", p.aud);
  console.log("exp:", new Date(p.exp * 1000).toISOString());
  console.log("all keys:", Object.keys(p).join(", "));

  // Test snippet API with each token
  const resp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", Authorization: "Bearer " + c.token },
    body: JSON.stringify({ filter: { type: "snippet" }, offset: 0, limit: 100 }),
  });
  console.log("Snippet API:", resp.status);
  if (resp.ok) {
    const data = (await resp.json()) as any;
    let count = 0;
    for (const t of (data.threads || [])) {
      for (const m of (t.messages || [])) {
        if (m.draft?.action === "snippet") {
          count++;
          console.log(`  -> "${m.draft.name}" (${m.draft.snippetAnalytics?.sends || 0} sends)`);
        }
      }
    }
    console.log(`Snippets found: ${count}`);
  } else {
    const text = await resp.text();
    console.log("Error:", text.slice(0, 200));
  }
  console.log();
}

await mainClient.close();
await swClient.close();
