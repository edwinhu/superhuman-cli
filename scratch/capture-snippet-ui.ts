import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

// Monkey-patch fetch on BOTH SW and main page
for (const [client, label] of [[swClient, "SW"], [mainClient, "main"]] as const) {
  await client.Runtime.evaluate({
    expression: `
      (() => {
        if (self.__origFetch) return "already patched";
        self.__origFetch = self.fetch;
        self.__capturedTokens = [];
        self.fetch = async function(...args) {
          const [input, init] = args;
          const url = typeof input === "string" ? input : input?.url || "";
          if (url.includes("superhuman.com")) {
            let auth = "";
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                auth = init.headers.get("Authorization") || "";
              } else if (typeof init.headers === "object") {
                auth = init.headers["Authorization"] || init.headers["authorization"] || "";
              }
            }
            self.__capturedTokens.push({
              url: url.slice(0, 150),
              auth: auth.slice(0, 200),
              hasBody: !!init?.body,
              bodyPreview: typeof init?.body === "string" ? init.body.slice(0, 200) : "",
              time: Date.now(),
            });
          }
          return self.__origFetch.apply(this, args);
        };
        return "patched";
      })()
    `,
    returnByValue: true,
  });
  console.log(`${label}: fetch patched`);
}

// Navigate to ehu account first
console.log("\nMake sure you're on ehu@law.virginia.edu...");
await mainClient.Page.navigate({ url: "https://mail.superhuman.com/ehu@law.virginia.edu" });
await new Promise(r => setTimeout(r, 5000));

// Now simulate pressing ; to open the snippet picker (Superhuman shortcut)
console.log("Sending semicolon key to open snippet picker...");
await mainClient.Input.dispatchKeyEvent({ type: "keyDown", key: ";", code: "Semicolon", text: ";" });
await mainClient.Input.dispatchKeyEvent({ type: "keyUp", key: ";", code: "Semicolon" });

console.log("Waiting 10 seconds...");
await new Promise(r => setTimeout(r, 10000));

// Check what was captured
for (const [client, label] of [[swClient, "SW"], [mainClient, "main"]] as const) {
  const r = await client.Runtime.evaluate({
    expression: `JSON.stringify(self.__capturedTokens || [])`,
    returnByValue: true,
  });
  const tokens = JSON.parse(r.result.value as string);
  console.log(`\n${label}: ${tokens.length} captured`);
  for (const t of tokens) {
    console.log(`  ${t.url}`);
    console.log(`    auth: ${t.auth.slice(0, 60) || "(none)"}...`);
    if (t.bodyPreview) console.log(`    body: ${t.bodyPreview.slice(0, 100)}`);
  }

  // Cleanup
  await client.Runtime.evaluate({
    expression: `self.fetch = self.__origFetch; delete self.__origFetch; delete self.__capturedTokens;`,
  });
}

await swClient.close();
await mainClient.close();
