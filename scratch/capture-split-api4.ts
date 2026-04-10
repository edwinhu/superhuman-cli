#!/usr/bin/env bun
/**
 * 1. Read split inbox settings from userdata (server-side)
 * 2. Check if we can read the "important definition" from settings
 * 3. Test using the approximateGmailSearch query directly with Gmail API
 */

import CDP from "chrome-remote-interface";
import { loadTokensFromDisk, getCachedToken, getCachedAccounts, superhumanFetch } from "../src/token-api";

const CDP_PORT = 9400;

async function main() {
  // Load tokens
  await loadTokensFromDisk();

  // 1. Try reading split inbox settings from userdata
  console.log("=== Reading splitInboxes from userdata ===\n");
  const accounts = getCachedAccounts();
  for (const email of accounts) {
    const token = await getCachedToken(email);
    if (!token?.idToken) continue;

    console.log(`Account: ${email}`);

    // Try reading splitInboxes settings
    try {
      const result = await superhumanFetch(token.idToken, "/v3/userdata.read", {
        method: "POST",
        body: JSON.stringify({ path: "settings/splitInboxes" }),
      });
      console.log("splitInboxes:", JSON.stringify(result, null, 2)?.slice(0, 2000));
    } catch (e) {
      console.log("Error reading splitInboxes:", (e as Error).message.slice(0, 200));
    }

    // Try readUserData
    try {
      const result = await superhumanFetch(token.idToken, "/v3/userdata.readUserData", {
        method: "POST",
        body: JSON.stringify({ path: "settings/splitInboxes" }),
      });
      console.log("readUserData splitInboxes:", JSON.stringify(result, null, 2)?.slice(0, 2000));
    } catch (e) {
      console.log("Error:", (e as Error).message.slice(0, 200));
    }

    // Try getting all settings
    try {
      const result = await superhumanFetch(token.idToken, "/v3/userdata.readUserData", {
        method: "POST",
        body: JSON.stringify({ path: "settings" }),
      });
      if (result) {
        const keys = Object.keys(result);
        console.log("Settings keys:", keys);
        if (result.splitInboxes) {
          console.log("splitInboxes from settings:", JSON.stringify(result.splitInboxes, null, 2)?.slice(0, 2000));
        }
      }
    } catch (e) {
      console.log("Error:", (e as Error).message.slice(0, 200));
    }

    break; // Just test one account
  }

  // 2. Use CDP to get the actual queries and test them
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find(t =>
    t.url.includes("mail.superhuman.com") && t.type === "page" &&
    !t.url.includes("background_page") && !t.url.includes("tabs.html")
  );
  if (!mainPage) { console.error("No UI page"); return; }

  const client = await CDP({ port: CDP_PORT, target: mainPage.id });

  // 3. Get settings from Superhuman's internal state
  console.log("\n=== Superhuman settings.splitInboxes ===\n");
  const r1 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const settings = ga?.labels?._settings;
        if (!settings) return { error: "No settings" };

        const cache = settings._cache;
        if (!cache) return { error: "No cache" };

        // Get splitInboxes from cache
        const si = cache.splitInboxes || cache.split_inboxes;
        if (si) return si;

        // Check all keys
        const keys = Object.keys(cache);
        const splitRelated = keys.filter(k => k.toLowerCase().includes('split') || k.toLowerCase().includes('important'));
        return { allKeys: keys.slice(0, 30), splitRelated };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r1.result?.value, null, 2));

  // 4. Get the full settings._cache to find split config
  console.log("\n=== Full settings cache keys ===\n");
  const r2 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const settings = ga?.labels?._settings;
        if (!settings?._cache) return { error: "No cache" };

        const cache = settings._cache;
        const result = {};
        for (const k of Object.keys(cache)) {
          const v = cache[k];
          if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            result[k] = v;
          } else if (Array.isArray(v)) {
            result[k] = '[Array(' + v.length + ')]';
          } else {
            result[k] = '[obj: ' + Object.keys(v).slice(0, 8).join(',') + ']';
          }
        }
        return result;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r2.result?.value, null, 2));

  // 5. Get splitInboxesV2 specifically
  console.log("\n=== splitInboxesV2 ===\n");
  const r3 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const cache = ga?.labels?._settings?._cache;
        if (!cache) return { error: "No cache" };

        // Check for various split inbox key names
        for (const key of ['splitInboxes', 'splitInboxesV2', 'split_inboxes', 'splitInboxSettings']) {
          if (cache[key]) {
            return { key, value: cache[key] };
          }
        }

        // Check for importantDefinition
        if (cache.importantDefinition) {
          return { key: 'importantDefinition', value: cache.importantDefinition };
        }

        return { error: "No split inbox settings found", keys: Object.keys(cache) };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r3.result?.value, null, 2));

  // 6. Check the listRouter's actual _settings
  console.log("\n=== listRouter._settings._cache ===\n");
  const r4 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr?._settings?._cache) return { error: "No listRouter settings" };

        const cache = lr._settings._cache;
        const result = {};
        for (const k of Object.keys(cache)) {
          const v = cache[k];
          if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            result[k] = v;
          } else if (Array.isArray(v)) {
            // For arrays, show first element structure
            if (v.length > 0 && typeof v[0] === 'object') {
              result[k] = { _array: true, length: v.length, firstElementKeys: Object.keys(v[0]) };
            } else {
              result[k] = v;
            }
          } else {
            result[k] = '[obj: ' + Object.keys(v).slice(0, 10).join(',') + ']';
          }
        }
        return result;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r4.result?.value, null, 2));

  // 7. Get the split inbox definitions with their queries
  console.log("\n=== Split inbox definitions with raw queries ===\n");
  const r5 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr?._settings?._cache) return { error: "No settings" };

        const cache = lr._settings._cache;
        const splitInboxes = cache.splitInboxes || cache.splitInboxesV2;
        if (!splitInboxes) return { error: "No splitInboxes in cache" };

        // Return raw split inbox data
        return splitInboxes;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r5.result?.value, null, 2));

  // 8. Try reading splitInboxes from userdata via backend
  console.log("\n=== backend.readUserData for split inboxes ===\n");
  const r6 = await client.Runtime.evaluate({
    expression: `
      (async () => {
        const ga = window.GoogleAccount;
        const backend = ga?.backend;
        if (!backend?.readUserData) return { error: "No readUserData" };

        try {
          const result = await backend.readUserData({ path: "settings" });
          if (!result) return { result: null };

          // Check for splitInboxes
          const keys = Object.keys(result);
          const splitKeys = keys.filter(k => k.toLowerCase().includes('split') || k.toLowerCase().includes('important'));

          // Return splitInboxes if found
          if (result.splitInboxes) {
            return { splitInboxes: result.splitInboxes };
          }
          if (result.splitInboxesV2) {
            return { splitInboxesV2: result.splitInboxesV2 };
          }

          return { keys, splitKeys };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(r6.result?.value, null, 2));

  // 9. Now the key test: use the Gmail query directly
  console.log("\n=== Testing Gmail API with Important query ===\n");
  const r7 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr) return { error: "No listRouter" };

        // Get the Gmail queries
        return {
          importantQuery: lr.approximateGmailSearch('SH_IMPORTANT'),
          otherQuery: lr.approximateGmailSearch('SH_OTHER'),
        };
      })()
    `,
    returnByValue: true,
  });
  const queries = r7.result?.value;
  console.log("Important query:", queries?.importantQuery?.slice(0, 200));

  if (queries?.importantQuery) {
    // Test this query against Gmail API
    const gmailAccount = await getCachedToken("eddyhu@gmail.com");
    if (gmailAccount) {
      const query = encodeURIComponent(queries.importantQuery);
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${query}&maxResults=5`;
      console.log("\nFetching Gmail with Important query...");
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${gmailAccount.accessToken}` },
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        console.log("Thread count:", data.threads?.length, "resultSizeEstimate:", data.resultSizeEstimate);
        if (data.threads?.length > 0) {
          console.log("First thread ID:", data.threads[0].id);
        }
      } else {
        console.log("Gmail API error:", resp.status, await resp.text());
      }
    }
  }

  await client.close();
}

main().catch(console.error);
