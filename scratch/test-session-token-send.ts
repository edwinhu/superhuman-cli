#!/usr/bin/env bun
import CDP from "chrome-remote-interface";
const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  const client = await CDP({ target: mainPage.id, port: CDP_PORT });
  const { Runtime, Network } = client;
  
  await Network.enable({ maxPostDataSize: 10000 });
  Network.requestWillBeSent((p: any) => {
    if (p.request.url.includes('sessions.getTokens') || p.request.url.includes('getCsrfToken')) {
      console.log("SESSION REQ:", p.request.url, JSON.stringify(p.request.headers));
      if (p.request.postData) console.log("  body:", p.request.postData.substring(0,200));
    }
  });
  Network.responseReceived(async (p: any) => {
    if (p.response.url.includes('sessions.getTokens') || p.response.url.includes('getCsrfToken')) {
      console.log("SESSION RESP:", p.response.url, p.response.status);
      try {
        const b = await Network.getResponseBody({ requestId: p.requestId });
        console.log("  body:", b.body?.substring(0,300));
      } catch {}
    }
  });
  
  const result = await Runtime.evaluate({
    expression: `(async () => {
      try {
        const ga = window.GoogleAccount;
        const cred = ga.credential;
        const authData = cred._authData;
        
        // Step 1: Get CSRF token
        let csrfToken = null;
        try {
          csrfToken = await cred.getCsrfToken();
          console.log('Got CSRF token:', csrfToken?.substring(0,20));
        } catch(e) {
          return {error: 'getCsrfToken failed: ' + e.message};
        }
        
        // Step 2: Get session tokens
        let sessionToken = null;
        try {
          // Use the accounts subdomain
          const resp = await fetch('https://accounts.superhuman.com/~backend/v3/sessions.getTokens', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrfToken,
              'Cache-Control': 'no-store',
              'x-superhuman-session-id': 'test-' + crypto.randomUUID(),
              'x-superhuman-user-email': authData.emailAddress,
            },
            body: JSON.stringify({emailAddress: authData.emailAddress, googleId: authData.userId}),
          });
          const data = await resp.json();
          console.log('sessions.getTokens status:', resp.status, 'keys:', Object.keys(data));
          sessionToken = data.idToken;
          if (sessionToken) {
            const payload = JSON.parse(atob(sessionToken.split('.')[1]));
            console.log('Session token issuer:', payload.iss, 'aud:', payload.aud);
          }
          return {status: resp.status, keys: Object.keys(data), tokenPreview: sessionToken?.substring(0,50)};
        } catch(e) {
          return {error: 'sessions.getTokens failed: ' + e.message};
        }
      } catch(e) {
        return {error: e.message};
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 15000,
  });
  
  console.log("Result:", JSON.stringify(result.result.value, null, 2));
  await new Promise(r => setTimeout(r, 1000));
  await client.close();
}

main().catch(console.error);
