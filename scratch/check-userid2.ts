#!/usr/bin/env bun
import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  
  // Token-api uses the MAIN PAGE (not service worker) to get token
  // Let me check what the main page has
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  
  const client = await CDP({ target: mainPage.id, port: CDP_PORT });
  const { Runtime } = client;
  
  const result = await Runtime.evaluate({
    expression: `(async () => {
      const ga = window.GoogleAccount;
      const cred = ga?.credential;
      const authData = cred?._authData;
      const user = cred?.user;
      
      // Decode JWT to get sub
      const idToken = authData?.idToken;
      let jwtSub = null;
      if (idToken) {
        try {
          const parts = idToken.split('.');
          const payload = JSON.parse(atob(parts[1]));
          jwtSub = payload.sub;
        } catch(e) {}
      }
      
      // Get userId from token-api's method (user._id)
      const userId_from_user_id = user?._id;
      
      // Also try ga.labels._settings._cache.userId
      const shUserId = ga?.labels?._settings?._cache?.userId;
      
      return {
        'userId (user._id)': userId_from_user_id,
        'jwtSub': jwtSub,
        'shUserId (externalId)': shUserId,
        'authData.userId': authData?.userId,
        'email': authData?.emailAddress,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  
  console.log(JSON.stringify(result.result.value, null, 2));
  await client.close();
}

main().catch(console.error);
