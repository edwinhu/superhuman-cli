#!/usr/bin/env bun
/**
 * Try to trigger messages/send from the EXTENSION service worker context
 * where it might have different auth/capabilities
 */
import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  
  // Extension service worker
  const extSW = targets.find((t: any) => 
    t.type === "service_worker" && t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn")
  );
  
  console.log("Extension SW:", extSW?.url);
  
  const client = await CDP({ target: extSW.id, port: CDP_PORT });
  const { Runtime, Network } = client;
  
  // Inspect backgrounds object
  const result = await Runtime.evaluate({
    expression: `(async () => {
      try {
        const bgs = Object.values(backgrounds || {});
        if (!bgs.length) return {error: 'no backgrounds'};
        
        const bg = bgs[0];
        const ab = bg._accountBackground || bg;
        
        // Look for the backend or send function
        const bgKeys = Object.keys(bg);
        const abKeys = Object.keys(ab);
        
        // Try to find token via different paths
        const tryPaths = [
          () => ab._authData?.idToken,
          () => ab._credential?._authData?.idToken,
          () => bg._credential?._authData?.idToken,
          () => bg._authData?.idToken,
        ];
        
        let token = null;
        for (const fn of tryPaths) {
          try { token = fn(); if (token) break; } catch {}
        }
        
        // Find backend
        const backend = ab._backend || ab.backend || bg._backend || bg.backend;
        const hasBackend = !!backend;
        const backendKeys = hasBackend ? Object.keys(backend).slice(0,15) : [];
        
        return {bgKeys: bgKeys.slice(0,20), abKeys: abKeys.slice(0,20), token: token?.substring(0,30), hasBackend, backendKeys};
      } catch(e) {
        return {error: e.message};
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  
  console.log("SW exploration:", JSON.stringify(result.result.value, null, 2));
  
  await client.close();
}

main().catch(console.error);
