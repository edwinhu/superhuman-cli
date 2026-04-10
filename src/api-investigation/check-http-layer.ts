#!/usr/bin/env bun
/**
 * Check the actual HTTP layer (Ae.a.backend) and auth details
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Check HTTP Layer & Auth Details");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime } = client;

  // 1. Get externalUserId and CSRF token
  console.log("\n1. Auth identifiers");
  console.log("-".repeat(40));

  const authIds = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        const cred = backend?._credential || ga?.credential;

        let externalId = null;
        try { externalId = cred?.getExternalId?.(); } catch (e) { externalId = "ERROR: " + e.message; }

        let csrfToken = null;
        try { csrfToken = await cred?.getCsrfToken?.(); } catch (e) { csrfToken = "ERROR: " + e.message; }

        let externalIdSrc = null;
        try { externalIdSrc = cred?.getExternalId?.toString()?.substring(0, 500); } catch {}

        let getCsrfSrc = null;
        try { getCsrfSrc = cred?.getCsrfToken?.toString()?.substring(0, 500); } catch {}

        return {
          externalId,
          csrfToken,
          externalIdSrc,
          getCsrfSrc,
        };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(authIds.result.value, null, 2));

  // 2. Find and dump Ae.a.backend (the HTTP utility)
  console.log("\n2. HTTP utility (Ae.a.backend) source");
  console.log("-".repeat(40));

  const httpUtil = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend) return { error: "No backend" };

        // The fetch method calls Ae.a.backend(r, opts)
        // Ae.a is likely a module import. Let's trace it by looking at
        // what the fetch method references.
        const fetchSrc = backend.fetch.toString();

        // Try to find the backend HTTP function by name patterns
        // in the module scope. The function is in a closure.
        // Let's try a different approach: monkey-patch fetch to see
        // what actually gets called.

        // Actually, let's look at the prototype chain for the HTTP module
        // by examining the constructor
        const backendClass = backend.constructor;
        const backendSrc = backendClass.toString().substring(0, 5000);

        // Also look for _appToBackendContact
        let contactSrc = null;
        try {
          contactSrc = backend._appToBackendContact?.toString()?.substring(0, 500);
        } catch {}

        return {
          backendClassSrc: backendSrc,
          contactSrc,
        };
      })()
    `,
    returnByValue: true,
  });

  console.log("Backend class:", httpUtil.result.value.backendClassSrc?.substring(0, 2000));
  console.log("\n_appToBackendContact:", httpUtil.result.value.contactSrc);

  // 3. Find the actual HTTP request builder
  console.log("\n\n3. Tracing the actual HTTP request for messages/send");
  console.log("-".repeat(40));

  // Use Network domain to capture the next messages/send request
  const { Network } = client;
  await Network.enable();

  // But also, let me look for the HTTP utility by examining closures
  const closureExplore = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;

        // Try calling fetch with a test path to see what gets constructed
        // We can intercept the global fetch to see what URL/headers are used
        const origFetch = window._originalFetch || window.fetch;
        let capturedRequest = null;

        // Temporarily replace global fetch
        window.fetch = function(url, init) {
          if (typeof url === 'string' && url.includes('__test_capture__')) {
            capturedRequest = {
              url,
              method: init?.method,
              headers: init?.headers ? (
                init.headers instanceof Headers
                  ? Object.fromEntries(init.headers.entries())
                  : {...init.headers}
              ) : null,
              credentials: init?.credentials,
            };
            // Don't actually send - return a fake response
            return Promise.resolve(new Response('{"test": true}', { status: 200 }));
          }
          return origFetch.apply(this, arguments);
        };

        // Now try to call backend.fetch with a test endpoint
        try {
          // This won't send a real request because we intercepted it
          // But it WILL build the full request including headers
          await backend.fetch("/__test_capture__", {
            endpoint: "test",
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ test: true }),
          });
        } catch (e) {
          // Might fail due to network check, but that's ok
          capturedRequest = capturedRequest || { error: e.message };
        }

        // Restore fetch
        window.fetch = origFetch;

        return capturedRequest;
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log("Captured request:", JSON.stringify(closureExplore.result.value, null, 2));

  // 4. Try using CDP Network to see the ACTUAL headers on a real request
  // Let's intercept the next backend request
  console.log("\n\n4. Setting up Network interception for real request headers");
  console.log("-".repeat(40));

  // Trigger a lightweight backend call to see headers
  const triggerResult = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;

        // Call messages/send/log with a dummy payload - this is lightweight
        // and uses the same fetch() path
        try {
          const result = await backend.logSend({
            action: "cancel",
            draft_message_id: "test_probe",
            draft_thread_id: "test_probe",
          });
          return { success: true };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log("Trigger result:", JSON.stringify(triggerResult.result.value, null, 2));

  // Wait a moment for network events
  await new Promise(r => setTimeout(r, 2000));

  // 5. Now let me directly find the HTTP utility by searching module exports
  console.log("\n\n5. Direct trace: what headers does the HTTP layer add?");
  console.log("-".repeat(40));

  const headerTrace = await Runtime.evaluate({
    expression: `
      (async () => {
        // Install a more thorough fetch interceptor that captures ALL details
        const origFetch = window._originalFetch || window.fetch;
        let captured = null;

        window.fetch = function(resource, init) {
          const url = typeof resource === 'string' ? resource :
                      resource instanceof Request ? resource.url : String(resource);

          if (url.includes('mail.superhuman.com') && url.includes('/send')) {
            const hdrs = {};
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                for (const [k, v] of init.headers.entries()) {
                  hdrs[k] = v.length > 100 ? v.substring(0, 100) + '...' : v;
                }
              } else {
                for (const [k, v] of Object.entries(init.headers)) {
                  hdrs[k] = typeof v === 'string' && v.length > 100 ? v.substring(0, 100) + '...' : v;
                }
              }
            }

            captured = {
              url: url.substring(0, 200),
              method: init?.method,
              headers: hdrs,
              credentials: init?.credentials,
              mode: init?.mode,
              hasBody: !!init?.body,
            };
          }
          return origFetch.apply(this, arguments);
        };

        // Trigger logSend to see what headers the backend adds
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        try {
          await backend.logSend({
            action: "cancel",
            draft_message_id: "test_header_probe",
            draft_thread_id: "test_header_probe",
          });
        } catch {}

        // Restore
        window.fetch = origFetch;

        return captured || { note: "No fetch captured - send may go through service worker" };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(headerTrace.result.value, null, 2));

  // 6. Check in the service worker where the actual HTTP calls happen
  console.log("\n\n6. Service Worker HTTP utility");
  console.log("-".repeat(40));

  const sw = targets.find((t: any) => t.type === "service_worker");
  if (sw) {
    const swClient = await CDP({ target: sw.id, port: CDP_PORT, host });

    const swHttpUtil = await swClient.Runtime.evaluate({
      expression: `
        (async () => {
          // The service worker likely has the actual HTTP utility
          const email = "eddyhu@gmail.com";
          const bg = backgrounds?.[email]?._accountBackground;
          if (!bg) return { error: "No bg", keys: Object.keys(backgrounds || {}) };

          const backend = bg.backend;
          if (!backend) return { error: "No backend on bg" };

          // Get fetch source from service worker context
          let fetchSrc = backend.fetch?.toString()?.substring(0, 2000);

          // Get the credential's externalId
          let externalId = null;
          try {
            externalId = backend._credential?.getExternalId?.();
          } catch (e) {
            externalId = "ERROR: " + e.message;
          }

          // Install interceptor here
          const origFetch = self._originalFetch || self.fetch;
          let captured = null;

          self.fetch = function(resource, init) {
            const url = typeof resource === 'string' ? resource :
                        resource instanceof Request ? resource.url : String(resource);
            if (url.includes('superhuman.com') && url.includes('/send')) {
              const hdrs = {};
              if (init?.headers) {
                if (init.headers instanceof Headers) {
                  for (const [k, v] of init.headers.entries()) {
                    hdrs[k] = v.length > 100 ? v.substring(0, 100) + '...' : v;
                  }
                } else {
                  for (const [k, v] of Object.entries(init.headers)) {
                    hdrs[k] = typeof v === 'string' && v.length > 100 ? v.substring(0, 100) + '...' : v;
                  }
                }
              }
              captured = { url: url.substring(0, 200), method: init?.method, headers: hdrs, credentials: init?.credentials };
            }
            return origFetch.apply(this, arguments);
          };

          // Trigger a log call
          try {
            await backend.logSend({
              action: "cancel",
              draft_message_id: "sw_test_probe",
              draft_thread_id: "sw_test_probe",
            });
          } catch {}

          self.fetch = origFetch;

          return {
            externalId,
            fetchSrc,
            captured: captured || "No fetch captured in SW",
          };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });

    console.log(JSON.stringify(swHttpUtil.result.value, null, 2));
    await swClient.close();
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
