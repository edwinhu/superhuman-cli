import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

const { Fetch: SwFetch } = swClient;
// Intercept everything
await SwFetch.enable({ patterns: [{ urlPattern: "*" }] });

// Capture ALL request details
const allRequests: Array<{
  url: string;
  headers: Record<string, string>;
  tokenInfo?: { sub: string; iss: string; aud: string; exp: string };
}> = [];

SwFetch.requestPaused(async ({ requestId, request }: any) => {
  if (request.url.includes("superhuman.com")) {
    const entry: typeof allRequests[0] = {
      url: request.url,
      headers: request.headers,
    };
    const auth = request.headers["Authorization"] || "";
    if (auth.startsWith("Bearer ")) {
      try {
        const payload = JSON.parse(Buffer.from(auth.slice(7).split(".")[1], "base64url").toString());
        entry.tokenInfo = {
          sub: payload.sub,
          iss: payload.iss,
          aud: String(payload.aud),
          exp: new Date(payload.exp * 1000).toISOString(),
        };
      } catch {}
    }
    allRequests.push(entry);
  }
  await SwFetch.continueRequest({ requestId });
});

// Navigate to ehu and reload
console.log("Navigating to ehu@law.virginia.edu and reloading...");
await mainClient.Page.navigate({ url: "https://mail.superhuman.com/ehu@law.virginia.edu" });
await new Promise(r => setTimeout(r, 2000));
await mainClient.Page.reload();

console.log("Waiting 20 seconds...");
await new Promise(r => setTimeout(r, 20000));

await SwFetch.disable();

console.log(`\nTotal superhuman requests: ${allRequests.length}\n`);

// Group by unique token
const tokenGroups = new Map<string, { endpoints: string[]; headers: Record<string, string>; tokenInfo: any }>();

for (const req of allRequests) {
  const auth = req.headers["Authorization"] || "";
  const tokenKey = auth ? auth.slice(7, 47) : "no-auth";

  if (!tokenGroups.has(tokenKey)) {
    tokenGroups.set(tokenKey, {
      endpoints: [],
      headers: req.headers,
      tokenInfo: req.tokenInfo,
    });
  }
  const endpoint = req.url.replace("https://mail.superhuman.com/", "");
  tokenGroups.get(tokenKey)!.endpoints.push(endpoint);
}

console.log(`Token groups: ${tokenGroups.size}\n`);

let groupIdx = 0;
for (const [tokenKey, group] of tokenGroups) {
  groupIdx++;
  console.log(`--- Group ${groupIdx}: ${tokenKey === "no-auth" ? "NO AUTH" : tokenKey + "..."} ---`);
  console.log(`  Endpoints: ${[...new Set(group.endpoints)].join(", ")}`);
  console.log(`  Email header: ${group.headers["x-superhuman-user-email"] || "(none)"}`);
  if (group.tokenInfo) {
    console.log(`  JWT iss: ${group.tokenInfo.iss}`);
    console.log(`  JWT sub: ${group.tokenInfo.sub}`);
    console.log(`  JWT aud: ${group.tokenInfo.aud}`);
    console.log(`  JWT exp: ${group.tokenInfo.exp}`);
  }

  // Test snippet API with each token that has auth
  if (tokenKey !== "no-auth") {
    const fullAuth = allRequests.find(r => (r.headers["Authorization"] || "").slice(7, 47) === tokenKey);
    if (fullAuth) {
      const token = fullAuth.headers["Authorization"]!.slice(7);
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
  }
  console.log();
}

await swClient.close();
await mainClient.close();
