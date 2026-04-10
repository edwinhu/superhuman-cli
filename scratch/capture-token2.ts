import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

const { Fetch: FetchDomain } = swClient;

await FetchDomain.enable({ patterns: [{ urlPattern: "*" }] });

let token = "";
FetchDomain.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  if (auth.startsWith("Bearer ") && token === "") {
    token = auth.slice(7);
    console.log("Got token from:", request.url.slice(0, 80));
  }
  await FetchDomain.continueRequest({ requestId });
});

// Simulate "g i" keyboard shortcut in Superhuman to go to inbox (triggers API calls)
console.log("Sending keyboard shortcut to trigger API calls...");
await mainClient.Input.dispatchKeyEvent({ type: "keyDown", key: "g", code: "KeyG", text: "g" });
await mainClient.Input.dispatchKeyEvent({ type: "keyUp", key: "g", code: "KeyG" });
await new Promise(r => setTimeout(r, 200));
await mainClient.Input.dispatchKeyEvent({ type: "keyDown", key: "i", code: "KeyI", text: "i" });
await mainClient.Input.dispatchKeyEvent({ type: "keyUp", key: "i", code: "KeyI" });

console.log("Waiting for API traffic...");
await new Promise(r => setTimeout(r, 8000));

await FetchDomain.disable();

if (token) {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  console.log("\nAccount:", payload.email || payload.sub);
  console.log("Expires:", new Date(payload.exp * 1000).toISOString());

  // Test snippet API
  const resp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", Authorization: "Bearer " + token },
    body: JSON.stringify({ filter: { type: "snippet" }, offset: 0, limit: 100 }),
  });
  console.log("Snippet API status:", resp.status);

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
    console.log(`Total snippets: ${count}`);
    if (count === 0) console.log("Raw:", JSON.stringify(data).slice(0, 200));
  } else {
    console.log("Error:", await resp.text());
  }
} else {
  console.log("No token captured — try interacting with Superhuman in the browser");
}

await mainClient.close();
await swClient.close();
