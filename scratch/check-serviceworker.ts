#!/usr/bin/env bun
import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  
  // Connect to the WEB service worker (not the extension SW)
  const webSW = targets.find((t: any) => 
    t.type === "service_worker" && t.url.includes("serviceworker.js")
  );
  
  if (!webSW) {
    console.error("Web service worker not found");
    process.exit(1);
  }
  
  console.log("Connected to web SW:", webSW.url);
  
  const client = await CDP({ target: webSW.id, port: CDP_PORT });
  const { Runtime, Network } = client;
  
  // Check what's in the service worker global scope
  const result = await Runtime.evaluate({
    expression: `(async () => {
      const keys = Object.keys(self).filter(k => !['onactivate','onfetch','oninstall','onmessage','onmessageerror','onsync','cookieStore','oncookiechange','skipWaiting'].includes(k));
      const hasFetch = typeof self.onfetch === 'function';
      const fetchSrc = hasFetch ? self.onfetch.toString().substring(0, 200) : 'no onfetch';
      return {keys: keys.slice(0,20), hasFetch, fetchSrc};
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  
  console.log(JSON.stringify(result.result.value, null, 2));
  
  // Try to monitor network from SW
  try {
    await Network.enable({ maxPostDataSize: 100000 });
    console.log("Network monitoring enabled on SW");
    
    Network.requestWillBeSent((params: any) => {
      if (params.request.url.includes("messages/send") || params.request.url.includes("superhuman")) {
        console.log("\nSW REQUEST:", params.request.url);
        console.log("Headers:", JSON.stringify(params.request.headers));
        if (params.request.postData) {
          console.log("Body:", params.request.postData.substring(0, 500));
        }
      }
    });
    
    console.log("\nMonitoring SW network for 30s... Now trigger a CLI send:");
    console.log("bun run src/cli.ts forward 19d697d727197777 --to ehu@law.virginia.edu --send");
    await new Promise(resolve => setTimeout(resolve, 30000));
  } catch(e) {
    console.log("Network not available on SW:", (e as Error).message);
  }
  
  await client.close();
}

main().catch(console.error);
