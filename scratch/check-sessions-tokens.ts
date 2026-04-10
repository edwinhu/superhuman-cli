#!/usr/bin/env bun
import CDP from "chrome-remote-interface";
const CDP_PORT = 9250;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  const client = await CDP({ target: mainPage.id, port: CDP_PORT });
  const { Runtime } = client;
  
  const result = await Runtime.evaluate({
    expression: `(async () => {
      try {
        const ga = window.GoogleAccount;
        const cred = ga.credential;
        const authData = cred._authData;
        
        // Check what tokens exist
        const idToken = authData?.idToken;
        const accessToken = authData?.accessToken;
        
        // Decode the idToken to see its issuer
        let idTokenPayload = null;
        if (idToken) {
          try {
            const parts = idToken.split('.');
            idTokenPayload = JSON.parse(atob(parts[1]));
          } catch {}
        }
        
        // Check csrfData
        const csrfData = cred._csrfData;
        
        // Try to call sessions.getTokens to see what it returns
        // (using the credential's _withCsrfTokenAsync)
        let sessionTokensResult = null;
        try {
          sessionTokensResult = await new Promise((resolve, reject) => {
            cred._withCsrfTokenAsync(async (csrfToken) => {
              const resp = await fetch('https://accounts.superhuman.com/~backend/v3/sessions.getTokens', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CSRF-Token': csrfToken,
                  'Cache-Control': 'no-store',
                },
                body: JSON.stringify({
                  emailAddress: authData.emailAddress,
                  googleId: authData.userId,
                })
              });
              const data = await resp.json();
              resolve({status: resp.status, keys: Object.keys(data), tokenPreview: data.idToken?.substring(0,50)});
            }).then(resolve).catch(reject);
          });
        } catch(e) {
          sessionTokensResult = {error: e.message};
        }
        
        return {
          idTokenIssuer: idTokenPayload?.iss,
          idTokenAud: idTokenPayload?.aud,
          idTokenSub: idTokenPayload?.sub,
          hasCsrfData: !!csrfData,
          csrfTokenPreview: csrfData?.csrfToken?.substring(0,20),
          sessionTokensResult,
        };
      } catch(e) {
        return {error: e.message};
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 15000,
  });
  
  console.log(JSON.stringify(result.result.value, null, 2));
  await client.close();
}

main().catch(console.error);
