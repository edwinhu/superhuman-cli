#!/usr/bin/env bun
import CDP from "chrome-remote-interface";
const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const extSW = targets.find((t: any) => 
    t.type === "service_worker" && t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn")
  );
  
  const client = await CDP({ target: extSW.id, port: CDP_PORT });
  const { Runtime, Network } = client;
  
  // Enable network to monitor what SW sends
  await Network.enable({ maxPostDataSize: 100000 });
  
  Network.requestWillBeSent((params: any) => {
    if (params.request.url.includes("messages/send") || params.request.url.includes("superhuman.com")) {
      console.log("\nSW FETCH:", params.request.url);
      console.log("Headers:", JSON.stringify(params.request.headers));
      if (params.request.postData) console.log("Body:", params.request.postData.substring(0, 300));
    }
  });
  
  // Deep exploration of ab
  const result = await Runtime.evaluate({
    expression: `(async () => {
      const bgs = Object.values(backgrounds || {});
      const bg = bgs[0];
      const ab = bg._accountBackground;
      
      // Look much deeper
      const allKeys = [];
      function findKeys(obj, prefix, depth) {
        if (depth > 3 || !obj || typeof obj !== 'object') return;
        for (const k of Object.keys(obj)) {
          allKeys.push(prefix + k);
          try {
            if (obj[k] && typeof obj[k] === 'object') findKeys(obj[k], prefix + k + '.', depth + 1);
          } catch {}
        }
      }
      findKeys(ab, '', 0);
      
      // Look for token/idToken/fetch
      const interesting = allKeys.filter(k => 
        k.includes('token') || k.includes('Token') || 
        k.includes('fetch') || k.includes('Fetch') ||
        k.includes('send') || k.includes('backend') ||
        k.includes('email') || k.includes('Email')
      );
      
      return {interesting: interesting.slice(0, 40)};
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  
  console.log("Interesting keys:", JSON.stringify(result.result.value, null, 2));
  await client.close();
}

main().catch(console.error);
