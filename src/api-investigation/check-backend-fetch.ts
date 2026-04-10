#!/usr/bin/env bun
/**
 * Check Backend fetch() method and _appToBackendDraft transformation
 *
 * Investigates what the backend's fetch() method adds (cookies, headers)
 * and how _appToBackendDraft transforms draft data before writing.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9250;

async function main() {
  console.log("Check Backend fetch() and _appToBackendDraft");
  console.log("=".repeat(60));

  const host = process.env.CDP_HOST || "localhost";
  const targets = await CDP.List({ host, port: CDP_PORT });
  const mainPage = targets.find((t: any) => t.url.includes("mail.superhuman.com") && t.type === "page");
  if (!mainPage) { console.error("No Superhuman page found"); process.exit(1); }

  const client = await CDP({ target: mainPage.id, port: CDP_PORT, host });
  const { Runtime } = client;

  // 1. Get the fetch method source from backend
  console.log("\n1. Backend fetch() method source");
  console.log("-".repeat(40));

  const fetchSrc = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend) return { error: "No backend" };

        // Get fetch method source - walk prototype chain
        let fetchSource = null;
        let fetchJSONSource = null;
        let proto = Object.getPrototypeOf(backend);
        while (proto && proto !== Object.prototype) {
          for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === 'fetch' && typeof backend[name] === 'function') {
              fetchSource = backend[name].toString().substring(0, 3000);
            }
            if (name === 'fetchJSON' && typeof backend[name] === 'function') {
              fetchJSONSource = backend[name].toString().substring(0, 3000);
            }
          }
          proto = Object.getPrototypeOf(proto);
        }

        return { fetchSource, fetchJSONSource };
      })()
    `,
    returnByValue: true,
  });

  const fetchResult = fetchSrc.result.value;
  console.log("fetch():", fetchResult.fetchSource?.substring(0, 2000));
  console.log("\nfetchJSON():", fetchResult.fetchJSONSource?.substring(0, 2000));

  // 2. Get _appToBackendDraft source
  console.log("\n\n2. _appToBackendDraft transformation");
  console.log("-".repeat(40));

  const draftTransform = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend) return { error: "No backend" };

        let src = null;
        if (typeof backend._appToBackendDraft === 'function') {
          src = backend._appToBackendDraft.toString().substring(0, 3000);
        }

        return { src };
      })()
    `,
    returnByValue: true,
  });

  console.log(draftTransform.result.value.src);

  // 3. Check what headers the backend.fetch() adds
  console.log("\n\n3. Headers from backend._getHeaders() or similar");
  console.log("-".repeat(40));

  const headerInfo = await Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend) return { error: "No backend" };

        // Look for _getHeaders, _buildHeaders, etc.
        const headerMethods = [];
        let proto = Object.getPrototypeOf(backend);
        while (proto && proto !== Object.prototype) {
          for (const name of Object.getOwnPropertyNames(proto)) {
            if ((name.includes('header') || name.includes('Header') ||
                 name.includes('cookie') || name.includes('Cookie') ||
                 name.includes('auth') || name.includes('Auth') ||
                 name.includes('credentials') || name.includes('Credentials') ||
                 name === '_credential' || name === '_config') &&
                typeof backend[name] === 'function') {
              headerMethods.push({
                name,
                source: backend[name].toString().substring(0, 500)
              });
            }
          }
          proto = Object.getPrototypeOf(proto);
        }

        // Check _credential object
        let credMethods = [];
        if (backend._credential) {
          let cp = Object.getPrototypeOf(backend._credential);
          while (cp && cp !== Object.prototype) {
            for (const name of Object.getOwnPropertyNames(cp)) {
              if (typeof backend._credential[name] === 'function' &&
                  (name.includes('token') || name.includes('Token') ||
                   name.includes('auth') || name.includes('Auth') ||
                   name.includes('header') || name.includes('Header'))) {
                credMethods.push(name);
              }
            }
            cp = Object.getPrototypeOf(cp);
          }
        }

        return { headerMethods, credMethods };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(headerInfo.result.value, null, 2));

  // 4. Try to trace what SEND_DELAY is (delay value)
  console.log("\n\n4. SEND_DELAY value");
  console.log("-".repeat(40));

  const delayInfo = await Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;

        // Try to find SEND_DELAY from the sendEmail closure
        // From source: delay:se.SEND_DELAY
        // se is likely a module with constants

        // Check backend properties for delay-related config
        let delay = null;
        try {
          // The SEND_DELAY is a module-level constant, try to find it
          // from user settings
          const settings = ga?.labels?._settings?._cache;
          delay = {
            undoDelay: settings?.undoDelay,
            sendDelay: settings?.sendDelay,
            scheduledSendDelay: settings?.scheduledSendDelay,
          };
        } catch {}

        return { delay };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(delayInfo.result.value, null, 2));

  // 5. Monkey-patch to intercept the actual send request
  console.log("\n\n5. Intercepting actual fetch call for messages/send");
  console.log("-".repeat(40));

  const interceptResult = await Runtime.evaluate({
    expression: `
      (() => {
        // Install a temporary interceptor on the global fetch to capture
        // the exact request that goes to messages/send
        if (!window._originalFetch) {
          window._originalFetch = window.fetch;
          window._capturedSendRequests = [];
          window.fetch = function(...args) {
            const [url, init] = args;
            const urlStr = typeof url === 'string' ? url : url?.url || '';
            if (urlStr.includes('messages/send') && !urlStr.includes('/log')) {
              window._capturedSendRequests.push({
                url: urlStr,
                method: init?.method,
                headers: init?.headers ? Object.fromEntries(
                  init.headers instanceof Headers
                    ? init.headers.entries()
                    : Object.entries(init.headers)
                ) : null,
                body: init?.body ? JSON.parse(init.body).outgoing_message : null,
                credentials: init?.credentials,
                timestamp: new Date().toISOString(),
              });
            }
            return window._originalFetch.apply(this, args);
          };
        }
        return {
          interceptorInstalled: true,
          previousCaptures: window._capturedSendRequests?.length || 0,
          instruction: "Now send an email from Superhuman UI, then run check-captured-send.ts"
        };
      })()
    `,
    returnByValue: true,
  });

  console.log(JSON.stringify(interceptResult.result.value, null, 2));

  // Also intercept on the background page if available
  const bg = targets.find((t: any) => t.url.includes("background_page"));
  if (bg) {
    const bgClient = await CDP({ target: bg.id, port: CDP_PORT, host });

    const bgIntercept = await bgClient.Runtime.evaluate({
      expression: `
        (() => {
          if (!self._originalFetch) {
            self._originalFetch = self.fetch;
            self._capturedSendRequests = [];
            self.fetch = function(...args) {
              const [url, init] = args;
              const urlStr = typeof url === 'string' ? url : url?.url || '';
              if (urlStr.includes('messages/send') && !urlStr.includes('/log')) {
                self._capturedSendRequests.push({
                  url: urlStr,
                  method: init?.method,
                  headers: init?.headers ? (
                    init.headers instanceof Headers
                      ? Object.fromEntries(init.headers.entries())
                      : typeof init.headers === 'object' ? {...init.headers} : init.headers
                  ) : null,
                  bodyKeys: init?.body ? Object.keys(JSON.parse(init.body)) : null,
                  body: init?.body ? JSON.parse(init.body) : null,
                  credentials: init?.credentials,
                  timestamp: new Date().toISOString(),
                });
              }
              return self._originalFetch.apply(this, args);
            };
          }
          return { bgInterceptorInstalled: true, captures: self._capturedSendRequests?.length || 0 };
        })()
      `,
      returnByValue: true,
    });

    console.log("Background page:", JSON.stringify(bgIntercept.result.value, null, 2));
    await bgClient.close();
  }

  // Also check the service worker
  const sw = targets.find((t: any) => t.type === "service_worker");
  if (sw) {
    const swClient = await CDP({ target: sw.id, port: CDP_PORT, host });

    const swIntercept = await swClient.Runtime.evaluate({
      expression: `
        (() => {
          if (!self._originalFetch) {
            self._originalFetch = self.fetch;
            self._capturedSendRequests = [];
            self.fetch = function(...args) {
              const [url, init] = args;
              const urlStr = typeof url === 'string' ? url : url?.url || '';
              if (urlStr.includes('messages/send') && !urlStr.includes('/log')) {
                self._capturedSendRequests.push({
                  url: urlStr,
                  method: init?.method,
                  headers: init?.headers ? (
                    init.headers instanceof Headers
                      ? Object.fromEntries(init.headers.entries())
                      : typeof init.headers === 'object' ? {...init.headers} : init.headers
                  ) : null,
                  bodyKeys: init?.body ? Object.keys(JSON.parse(init.body)) : null,
                  body: init?.body ? JSON.parse(init.body) : null,
                  credentials: init?.credentials,
                  timestamp: new Date().toISOString(),
                });
              }
              return self._originalFetch.apply(this, args);
            };
          }
          return { swInterceptorInstalled: true, captures: self._capturedSendRequests?.length || 0 };
        })()
      `,
      returnByValue: true,
    });

    console.log("Service worker:", JSON.stringify(swIntercept.result.value, null, 2));
    await swClient.close();
  }

  await client.close();
  console.log("\n\nInterceptors installed. Send an email from Superhuman UI,");
  console.log("then run: bun src/api-investigation/check-captured-send.ts");
}

main().catch(console.error);
