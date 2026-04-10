#!/usr/bin/env bun
/**
 * Check Provider ID vs User ID
 *
 * Tests the hypothesis that getProviderIdAsync() returns a different value
 * than user._id, which would explain why messages/send returns 520
 * (draft written to wrong Firebase path).
 *
 * Also captures the actual path used by the browser when writing drafts.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Check Provider ID vs User ID");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });

  // Try service worker first (Chrome extension mode), then background page
  const sw = targets.find((t: any) => t.url.includes("service_worker") || t.type === "service_worker");
  const bg = targets.find((t: any) => t.url.includes("background_page") || t.url.includes("background.html"));
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");

  console.log("\nAvailable targets:");
  for (const t of targets) {
    console.log(`  [${t.type}] ${t.url.substring(0, 100)}`);
  }

  // Connect to whichever is available
  const targetPage = mainPage || bg;
  if (!targetPage) {
    console.error("No Superhuman page found. Is Chrome running with CDP on port 9250?");
    process.exit(1);
  }

  console.log(`\nConnecting to: [${targetPage.type}] ${targetPage.url.substring(0, 80)}`);
  const client = await CDP({ target: targetPage.id, port: CDP_PORT, host });
  const { Runtime } = client;

  // 1. Compare user._id vs getProviderIdAsync() vs JWT sub
  console.log("\n1. ID Comparison");
  console.log("-".repeat(40));

  const idComparison = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const ga = window.GoogleAccount;
          if (!ga) return { error: "No GoogleAccount on this page" };

          const cred = ga.credential;
          const user = cred?.user;
          const authData = cred?._authData;

          // Get user._id (what our CLI uses)
          const userId = user?._id;

          // Get provider ID via getProviderIdAsync (what background.js uses for Firebase paths)
          let providerIdAsync = null;
          try {
            if (typeof cred?.getProviderIdAsync === 'function') {
              providerIdAsync = await cred.getProviderIdAsync();
            } else if (typeof user?.getProviderIdAsync === 'function') {
              providerIdAsync = await user.getProviderIdAsync();
            }
          } catch (e) {
            providerIdAsync = "ERROR: " + e.message;
          }

          // Try other provider ID methods
          let providerId = null;
          try {
            providerId = user?.providerId || cred?._providerId || null;
          } catch {}

          // Decode JWT to get sub claim
          let jwtSub = null;
          try {
            const idToken = authData?.idToken || await cred?.getIDTokenAsync?.();
            if (idToken) {
              const payload = JSON.parse(atob(idToken.split('.')[1]));
              jwtSub = payload.sub;
            }
          } catch {}

          // Get Superhuman's internal userId (the user_xxxx one)
          const shUserId = ga.labels?._settings?._cache?.userId;

          // Check backend's writeUserDataMessage path generation
          let backendWritePath = null;
          try {
            const backend = ga.backend;
            if (backend?.writeUserDataMessage) {
              backendWritePath = backend.writeUserDataMessage.toString().substring(0, 500);
            }
          } catch {}

          // Check if there's a getProviderIdAsync on the backend or account
          let backendProviderId = null;
          try {
            if (typeof ga.getProviderIdAsync === 'function') {
              backendProviderId = await ga.getProviderIdAsync();
            }
          } catch (e) {
            backendProviderId = "ERROR: " + e.message;
          }

          // Check di container for provider ID
          let diProviderId = null;
          try {
            const di = ga.di;
            if (di) {
              // Try common service names
              for (const name of ['providerId', 'providerAccount', 'accountId', 'userId']) {
                try {
                  const val = di.get?.(name);
                  if (val) diProviderId = { [name]: val };
                } catch {}
              }
            }
          } catch {}

          return {
            userId: userId,
            providerIdAsync: providerIdAsync,
            providerId: providerId,
            jwtSub: jwtSub,
            shUserId: shUserId,
            email: ga.emailAddress,
            backendProviderId: backendProviderId,
            diProviderId: diProviderId,
            idsMatch: userId === jwtSub,
            providerIdMatchesUserId: providerIdAsync === userId,
            backendWritePath: backendWritePath,
          };
        } catch (e) {
          return { error: e.message, stack: e.stack?.substring(0, 300) };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(idComparison.result.value, null, 2));

  // 2. Check what _appToBackend does to the draft write path
  console.log("\n2. Backend _appToBackend transformation");
  console.log("-".repeat(40));

  const appToBackend = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const ga = window.GoogleAccount;
          if (!ga) return { error: "No GoogleAccount" };

          const backend = ga.backend;
          if (!backend) return { error: "No backend" };

          // Look for writeMessage or writeUserDataMessage
          const methods = [];
          let proto = Object.getPrototypeOf(backend);
          while (proto && proto !== Object.prototype) {
            for (const name of Object.getOwnPropertyNames(proto)) {
              if (typeof backend[name] === 'function' &&
                  (name.includes('write') || name.includes('Write') ||
                   name.includes('send') || name.includes('Send') ||
                   name.includes('draft') || name.includes('Draft') ||
                   name.includes('provider') || name.includes('Provider'))) {
                methods.push(name);
              }
            }
            proto = Object.getPrototypeOf(proto);
          }

          // Get _appToBackend source
          let appToBackendSrc = null;
          if (typeof backend._appToBackend === 'function') {
            appToBackendSrc = backend._appToBackend.toString().substring(0, 1000);
          }

          // Get sendEmail source
          let sendEmailSrc = null;
          if (typeof backend.sendEmail === 'function') {
            sendEmailSrc = backend.sendEmail.toString().substring(0, 1500);
          }

          // Get writeUserDataMessage source
          let writeUserDataSrc = null;
          if (typeof backend.writeUserDataMessage === 'function') {
            writeUserDataSrc = backend.writeUserDataMessage.toString().substring(0, 1500);
          }

          return {
            relevantMethods: methods,
            appToBackendSrc,
            sendEmailSrc,
            writeUserDataSrc,
          };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(appToBackend.result.value, null, 2));

  // 3. Monitor actual userdata.writeMessage calls to see what path the browser uses
  console.log("\n3. Checking currentHistoryId and other send prerequisites");
  console.log("-".repeat(40));

  const sendPrereqs = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const ga = window.GoogleAccount;
          if (!ga) return { error: "No GoogleAccount" };

          const backend = ga.backend;

          // Check for currentHistoryId
          let historyId = null;
          try {
            historyId = backend?.currentHistoryId ||
                        ga.labels?._historyId ||
                        ga.labels?._settings?._cache?.historyId ||
                        null;
          } catch {}

          // Check for other fields that send might need
          let accountProps = {};
          try {
            for (const key of ['currentHistoryId', '_historyId', 'historyId', 'syncState']) {
              if (backend?.[key] !== undefined) {
                accountProps[key] = typeof backend[key] === 'object' ?
                  JSON.stringify(backend[key]).substring(0, 200) : backend[key];
              }
            }
          } catch {}

          // Check if logSend is called before send
          let logSendSrc = null;
          if (typeof backend.logSend === 'function') {
            logSendSrc = backend.logSend.toString().substring(0, 1000);
          }

          return {
            historyId,
            accountProps,
            logSendSrc,
          };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(sendPrereqs.result.value, null, 2));

  // 4. Now let's also check via the service worker if available
  if (sw) {
    console.log("\n4. Service Worker Provider ID check");
    console.log("-".repeat(40));

    const swClient = await CDP({ target: sw.id, port: CDP_PORT, host });
    const swResult = await swClient.Runtime.evaluate({
      expression: `
        (async () => {
          try {
            const email = "eddyhu@gmail.com";
            const bg = backgrounds?.[email]?._accountBackground;
            if (!bg) return { error: "No background for " + email, available: Object.keys(backgrounds || {}) };

            const user = bg.labels?._user;
            const userId = user?._id;

            // Try getProviderIdAsync
            let providerIdAsync = null;
            try {
              if (typeof bg.getProviderIdAsync === 'function') {
                providerIdAsync = await bg.getProviderIdAsync();
              } else if (typeof user?.getProviderIdAsync === 'function') {
                providerIdAsync = await user.getProviderIdAsync();
              }
            } catch (e) {
              providerIdAsync = "ERROR: " + e.message;
            }

            // Check writeUserDataMessage path
            let writeMethodSrc = null;
            try {
              writeMethodSrc = bg.backend?.writeUserDataMessage?.toString()?.substring(0, 1000) ||
                              bg.writeUserDataMessage?.toString()?.substring(0, 1000);
            } catch {}

            return {
              userId,
              providerIdAsync,
              email: bg.emailAddress || bg.email,
              writeMethodSrc,
            };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });

    console.log(JSON.stringify(swResult.result.value, null, 2));
    await swClient.close();
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
