#!/usr/bin/env bun
import CDP from "chrome-remote-interface";
const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const extSW = targets.find((t: any) => 
    t.type === "service_worker" && t.url.includes("dcgcnpooblobhncpnddnhoendgbnglpn")
  );
  
  const client = await CDP({ target: extSW.id, port: CDP_PORT });
  const { Runtime } = client;
  
  const result = await Runtime.evaluate({
    expression: `(async () => {
      // Check chrome.webRequest capabilities
      const manifest = chrome.runtime.getManifest();
      const permissions = manifest.permissions || [];
      const hostPermissions = manifest.host_permissions || [];
      const hasDNR = chrome.declarativeNetRequest !== undefined;
      const hasWebRequest = chrome.webRequest !== undefined;
      
      // Check if webRequest is intercepting messages/send
      let dnrRules = null;
      try {
        dnrRules = await chrome.declarativeNetRequest.getDynamicRules();
      } catch(e) {}
      
      return {
        permissions,
        hostPermissions: hostPermissions.slice(0,5),
        hasDNR,
        hasWebRequest,
        dnrRulesCount: dnrRules?.length,
        manifestVersion: manifest.manifest_version,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  
  console.log(JSON.stringify(result.result.value, null, 2));
  await client.close();
}

main().catch(console.error);
