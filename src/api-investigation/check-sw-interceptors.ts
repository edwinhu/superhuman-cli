#!/usr/bin/env bun
/**
 * Check if the Superhuman Chrome extension's service worker
 * intercepts or modifies fetch requests (especially messages/send).
 *
 * Chrome extensions can use:
 * - chrome.webRequest.onBeforeSendHeaders to add headers
 * - chrome.declarativeNetRequest rules
 * - fetch event listener to proxy requests
 *
 * This might explain why browser sends work but CLI doesn't.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Check Service Worker Interceptors");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });

  const sw = targets.find((t: any) => t.type === "service_worker");
  if (!sw) {
    console.error("No service worker found");
    process.exit(1);
  }

  console.log(`Service Worker: ${sw.url.substring(0, 80)}`);
  const client = await CDP({ target: sw.id, port: CDP_PORT, host });
  const { Runtime } = client;

  // 1. Check for chrome.webRequest handlers
  console.log("\n1. chrome.webRequest handlers");
  console.log("-".repeat(40));

  const webRequest = await Runtime.evaluate({
    expression: `
      (() => {
        const wr = chrome?.webRequest;
        if (!wr) return { error: "No chrome.webRequest" };

        // Check for registered listeners
        // We can't directly list them, but we can check if any are installed
        // by looking at the module code

        // Check for onBeforeSendHeaders specifically
        const hasBeforeSendHeaders = wr.onBeforeSendHeaders?.hasListeners?.() ?? null;
        const hasBeforeRequest = wr.onBeforeRequest?.hasListeners?.() ?? null;
        const hasHeadersReceived = wr.onHeadersReceived?.hasListeners?.() ?? null;
        const hasSendHeaders = wr.onSendHeaders?.hasListeners?.() ?? null;

        return {
          hasBeforeSendHeaders,
          hasBeforeRequest,
          hasHeadersReceived,
          hasSendHeaders,
        };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(webRequest.result.value, null, 2));

  // 2. Check for fetch event listener
  console.log("\n2. Fetch event listener");
  console.log("-".repeat(40));

  const fetchListener = await Runtime.evaluate({
    expression: `
      (() => {
        // Check if self.onfetch is defined
        const hasFetch = typeof self.onfetch === 'function';

        // Check if addEventListener('fetch') was called
        // We can look for common patterns

        return {
          hasFetch,
          onfetchType: typeof self.onfetch,
        };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(fetchListener.result.value, null, 2));

  // 3. Check what backgrounds object structure looks like
  // and if there's any request modification happening
  console.log("\n3. Service Worker global state");
  console.log("-".repeat(40));

  const swState = await Runtime.evaluate({
    expression: `
      (() => {
        // List all global variables in the service worker
        const globals = Object.keys(self).filter(k =>
          !k.startsWith('_') &&
          k !== 'chrome' &&
          k !== 'caches' &&
          k !== 'clients' &&
          k !== 'registration' &&
          k !== 'serviceWorker' &&
          typeof self[k] !== 'function'
        );

        // Check backgrounds structure
        const bgKeys = Object.keys(self.backgrounds || {});

        // Check for any custom fetch wrappers
        let customFetch = typeof self._originalFetch !== 'undefined';

        return {
          globalVars: globals.slice(0, 30),
          backgroundEmails: bgKeys,
          hasCustomFetch: customFetch,
        };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(swState.result.value, null, 2));

  // 4. Check for the HTTP utility (fetcher) in the service worker
  console.log("\n4. HTTP Fetcher in Service Worker");
  console.log("-".repeat(40));

  const swFetcher = await Runtime.evaluate({
    expression: `
      (() => {
        // Look for FetchWrapper or similar in the SW scope
        const email = "eddyhu@gmail.com";
        const bg = self.backgrounds?.[email]?._accountBackground;

        if (!bg) return { error: "No background for " + email };

        // Check if backend exists on background
        const backend = bg.backend;
        if (!backend) {
          // Look for backend in other places
          let foundAt = [];
          for (const key of Object.keys(bg)) {
            if (bg[key]?.fetch || bg[key]?.sendEmail) {
              foundAt.push(key);
            }
          }
          return { error: "No backend", bgKeys: Object.keys(bg).slice(0, 30), foundAt };
        }

        // Get the fetch method source
        const fetchSrc = backend.fetch?.toString()?.substring(0, 500);

        return { hasFetch: !!backend.fetch, fetchSrc };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(swFetcher.result.value, null, 2));

  // 5. Check the offscreen page
  console.log("\n5. Offscreen page check");
  console.log("-".repeat(40));

  const offscreen = targets.find((t: any) => t.url.includes("offscreen"));
  if (offscreen) {
    const osClient = await CDP({ target: offscreen.id, port: CDP_PORT, host });
    const osResult = await osClient.Runtime.evaluate({
      expression: `
        (() => {
          // Check if there are any fetch interceptors here
          const globals = Object.keys(self).filter(k =>
            k.includes('fetch') || k.includes('Fetch') ||
            k.includes('request') || k.includes('Request') ||
            k.includes('backend') || k.includes('Backend')
          );

          return {
            type: "offscreen",
            globals,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log(JSON.stringify(osResult.result.value, null, 2));
    await osClient.close();
  }

  // 6. KEY TEST: Try to find the Ae.a module (the HTTP fetcher)
  // by examining the main page's JS bundle
  console.log("\n6. Examining the HTTP fetcher (Ae.a.backend)");
  console.log("-".repeat(40));

  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (mainPage) {
    const mpClient = await CDP({ target: mainPage.id, port: CDP_PORT, host });

    const fetcherExplore = await mpClient.Runtime.evaluate({
      expression: `
        (async () => {
          const ga = window.GoogleAccount;
          const backend = ga?.backend;

          // We know backend.fetch calls Ae.a.backend(path, opts)
          // Let's monkey-patch backend.fetch to intercept the Ae.a.backend call
          // and examine what it does

          // Strategy: override backend.fetch temporarily and call sendEmail
          // with a mock, capturing what goes to Ae.a.backend

          const origFetch = backend.fetch.bind(backend);
          let capturedCall = null;

          // The real backend.fetch builds opts, then calls:
          //   Ae.a.backend(path, opts)
          // where opts = {email, demoMode, idToken, externalUserId, endpoint, method, headers, body, ...}

          // Let's intercept at a lower level: the global fetch
          // The Ae.a.backend function eventually calls window.fetch/self.fetch
          // Let's see what URL and init it produces

          const realGlobalFetch = window._originalFetch || window.fetch;
          let capturedGlobalFetch = null;

          window.fetch = function(resource, init) {
            const url = typeof resource === 'string' ? resource :
                        resource instanceof Request ? resource.url : String(resource);

            if (url.includes('messages/send') && !url.includes('/log')) {
              const hdrs = {};
              if (init?.headers) {
                if (init.headers instanceof Headers) {
                  for (const [k, v] of init.headers.entries()) {
                    hdrs[k] = v.length > 80 ? v.substring(0, 80) + '...' : v;
                  }
                } else if (typeof init.headers === 'object') {
                  for (const [k, v] of Object.entries(init.headers)) {
                    hdrs[k] = typeof v === 'string' && v.length > 80 ? v.substring(0, 80) + '...' : v;
                  }
                }
              }

              capturedGlobalFetch = {
                url,
                method: init?.method,
                headers: hdrs,
                credentials: init?.credentials,
                mode: init?.mode,
                cache: init?.cache,
                redirect: init?.redirect,
                referrer: init?.referrer,
                referrerPolicy: init?.referrerPolicy,
                signal: !!init?.signal,
              };

              // Don't actually send
              return Promise.resolve(new Response('{"send_at": 12345}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              }));
            }

            return realGlobalFetch.apply(this, arguments);
          };

          // Now call sendEmail and see what fetch call is made
          const mockMsg = {
            toJsonRequest: () => ({
              headers: [],
              from: ga.emailAddress,
              to: ['test@test.com'],
              subject: 'test',
              html_body: '<div>test</div>',
              superhuman_id: 'test',
              rfc822_id: '<test@test.com>',
              thread_id: 'test',
              message_id: 'test',
              attachments: [],
              current_message_ids: ['test'],
            }),
            getSubject: () => 'test',
            getSuperhumanId: () => 'test',
            getThreadId: () => 'test',
            getMessageId: () => 'test',
          };

          try {
            await backend.sendEmail(mockMsg);
          } catch {}

          window.fetch = realGlobalFetch;

          return capturedGlobalFetch || { note: "fetch not captured - request may have been blocked before global fetch" };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });

    console.log(JSON.stringify(fetcherExplore.result.value, null, 2));
    await mpClient.close();
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
