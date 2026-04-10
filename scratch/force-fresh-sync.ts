import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

// Monkey-patch fetch on the SW to capture ALL auth headers from all fetch calls
await swClient.Runtime.evaluate({
  expression: `
    (() => {
      if (self.__origFetch) return;
      self.__origFetch = self.fetch;
      self.__capturedAuth = [];
      self.fetch = async function(...args) {
        const [input, init] = args;
        const url = typeof input === "string" ? input : (input?.url || "");
        if (url.includes("superhuman.com/~backend")) {
          let auth = "";
          const headers = init?.headers;
          if (headers) {
            if (headers instanceof Headers) auth = headers.get("Authorization") || "";
            else if (typeof headers === "object") auth = headers["Authorization"] || headers["authorization"] || "";
          }
          self.__capturedAuth.push({ url, auth: auth.slice(0, 300), body: typeof init?.body === "string" ? init.body.slice(0, 200) : "" });
        }
        return self.__origFetch.apply(this, args);
      };
    })()
  `,
});

// Also set up CDP Fetch interception
const { Fetch: SwFetch } = swClient;
await SwFetch.enable({ patterns: [{ urlPattern: "*superhuman.com/~backend*" }] });

const cdpCaptures: Array<{ url: string; auth: string }> = [];
SwFetch.requestPaused(async ({ requestId, request }: any) => {
  const auth = request.headers["Authorization"] || "";
  cdpCaptures.push({ url: request.url, auth: auth.slice(0, 300) });
  await SwFetch.continueRequest({ requestId });
});

// Force destroy and restart the ehu background to trigger fresh auth
console.log("Destroying ehu background to force re-authentication...");
await swClient.Runtime.evaluate({
  expression: `(async () => {
    const entry = backgrounds["ehu@law.virginia.edu"];
    const bg = entry._accountBackground;
    // Destroy the background - this should force re-auth on restart
    await bg.destroyBackground();
    entry._accountBackgroundStatus = "destroyed";
    entry._accountBackground = null;
  })()`,
  awaitPromise: true,
});

console.log("Waiting 2 seconds...");
await new Promise(r => setTimeout(r, 2000));

// Now reload the page which should reinitialize the background with fresh auth
console.log("Reloading page to reinitialize...");
await mainClient.Page.navigate({ url: "https://mail.superhuman.com/ehu@law.virginia.edu" });

console.log("Waiting 20 seconds for fresh sync...");
await new Promise(r => setTimeout(r, 20000));

await SwFetch.disable();

// Check monkey-patch captures
const r = await swClient.Runtime.evaluate({
  expression: `JSON.stringify(self.__capturedAuth || [])`,
  returnByValue: true,
});
const monkeyCaptures = JSON.parse(r.result.value as string);

console.log(`\nMonkey-patch captures: ${monkeyCaptures.length}`);
for (const c of monkeyCaptures.slice(0, 10)) {
  console.log(`  ${c.url.slice(0, 80)}`);
  if (c.auth) {
    const token = c.auth.replace("Bearer ", "");
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      console.log(`    iss: ${payload.iss} | sub: ${payload.sub}`);
    } catch {
      console.log(`    auth: ${c.auth.slice(0, 60)}`);
    }
  }
}

console.log(`\nCDP Fetch captures: ${cdpCaptures.length}`);
for (const c of cdpCaptures.slice(0, 10)) {
  console.log(`  ${c.url.slice(0, 80)}`);
  if (c.auth) {
    const token = c.auth.replace("Bearer ", "");
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      console.log(`    iss: ${payload.iss} | sub: ${payload.sub}`);
    } catch {
      console.log(`    auth: ${c.auth.slice(0, 60)}`);
    }
  }
}

// Find any non-Microsoft token and test snippets with it
const allTokens = [
  ...monkeyCaptures.filter((c: any) => c.auth).map((c: any) => c.auth.replace("Bearer ", "")),
  ...cdpCaptures.filter(c => c.auth).map(c => c.auth.replace("Bearer ", "")),
];

const uniqueTokens = new Map<string, string>();
for (const t of allTokens) {
  try {
    const payload = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
    const key = payload.iss;
    if (!uniqueTokens.has(key)) uniqueTokens.set(key, t);
  } catch {}
}

console.log(`\nUnique token issuers: ${uniqueTokens.size}`);
for (const [iss, token] of uniqueTokens) {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  console.log(`\n=== iss: ${iss} ===`);

  const resp = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", Authorization: "Bearer " + token },
    body: JSON.stringify({ filter: { type: "snippet" }, offset: 0, limit: 100 }),
  });
  console.log(`  Snippet API: ${resp.status}`);
  if (resp.ok) {
    const data = (await resp.json()) as any;
    let count = 0;
    for (const thread of (data.threads || [])) {
      for (const m of (thread.messages || [])) {
        if (m.draft?.action === "snippet") {
          count++;
          console.log(`    -> "${m.draft.name}"`);
        }
      }
    }
    console.log(`  Snippets: ${count}`);
  } else {
    console.log(`  Error: ${(await resp.text()).slice(0, 200)}`);
  }
}

// Cleanup monkey-patch
await swClient.Runtime.evaluate({
  expression: `if (self.__origFetch) { self.fetch = self.__origFetch; delete self.__origFetch; delete self.__capturedAuth; }`,
});

await swClient.close();
await mainClient.close();
