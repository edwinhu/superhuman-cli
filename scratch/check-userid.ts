#!/usr/bin/env bun
import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  
  // Try service worker (where token-api.ts connects)
  const bgWorker = targets.find((t: any) => t.url.includes("background_page") && t.type === "service_worker");
  
  const client = await CDP({ target: bgWorker.id, port: CDP_PORT });
  const { Runtime } = client;
  
  const result = await Runtime.evaluate({
    expression: `(async () => {
      const bgs = Object.values(backgrounds || {});
      if (!bgs.length) return {error: 'no backgrounds'};
      const bg = bgs[0];
      const ab = bg._accountBackground || bg;
      
      // Decode JWT to get sub
      const idToken = ab?._authData?.idToken;
      let jwtSub = null;
      if (idToken) {
        const parts = idToken.split('.');
        const payload = JSON.parse(atob(parts[1]));
        jwtSub = payload.sub;
      }
      
      return {
        userId_from_user_id: ab?._user?._id,
        userExternalId: ab?._authData?.externalId,
        jwtSub,
        email: ab?._authData?.emailAddress,
        allAuthDataKeys: Object.keys(ab?._authData || {}),
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  
  console.log(JSON.stringify(result.result.value, null, 2));
  await client.close();
}

main().catch(console.error);
