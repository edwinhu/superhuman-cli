import CDP from "chrome-remote-interface";

const PORT = 9400;
const targets = await CDP.List({ port: PORT });

const sw = targets.find(t => t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn") && t.type === "service_worker")!;
const mainPage = targets.find(t => t.url.includes("mail.superhuman.com") && t.type === "page")!;

const swClient = await CDP({ port: PORT, target: sw.id });
const mainClient = await CDP({ port: PORT, target: mainPage.id });

const { Fetch: SwFetch } = swClient;

// Intercept ALL requests, not just superhuman
await SwFetch.enable({ patterns: [{ urlPattern: "*" }] });

const allRequests: Array<{ url: string; headers: Record<string, string> }> = [];

SwFetch.requestPaused(async ({ requestId, request }: any) => {
  // Capture everything from superhuman backend
  if (request.url.includes("superhuman.com")) {
    allRequests.push({
      url: request.url,
      headers: request.headers,
    });
  }
  await SwFetch.continueRequest({ requestId });
});

console.log("Reloading Superhuman page...");
await mainClient.Page.reload();

console.log("Waiting 20 seconds...");
await new Promise(r => setTimeout(r, 20000));

await SwFetch.disable();

console.log(`\nTotal superhuman requests: ${allRequests.length}\n`);

// Group by URL path
const byPath: Record<string, typeof allRequests> = {};
for (const req of allRequests) {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!byPath[path]) byPath[path] = [];
  byPath[path].push(req);
}

for (const [path, reqs] of Object.entries(byPath)) {
  console.log(`=== ${path} (${reqs.length} requests) ===`);
  const sample = reqs[0];
  const headerKeys = Object.keys(sample.headers);
  console.log("  Headers:", headerKeys.join(", "));
  const auth = sample.headers["Authorization"] || sample.headers["authorization"];
  if (auth) {
    console.log("  Auth:", auth.slice(0, 60) + "...");
  }
  const cookie = sample.headers["Cookie"] || sample.headers["cookie"];
  if (cookie) {
    console.log("  Cookie:", cookie.slice(0, 100) + "...");
  }
  // Check for any email-related URL params
  const email = new URL(sample.url).searchParams.get("email");
  if (email) console.log("  Email param:", email);
  console.log();
}

await mainClient.close();
await swClient.close();
