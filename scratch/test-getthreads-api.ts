#!/usr/bin/env bun
/**
 * Test the userdata.getThreads API with different listId filters
 * to see how to fetch Important vs Other threads.
 */

import { loadTokensFromDisk, getCachedToken, hasCachedSuperhumanCredentials, getCachedAccounts, superhumanFetch } from "../src/token-api";

async function main() {
  await loadTokensFromDisk();
  const accounts = getCachedAccounts();
  console.log("Accounts:", accounts);

  // Find an account with Superhuman credentials
  for (const email of accounts) {
    if (await hasCachedSuperhumanCredentials(email)) {
      const token = await getCachedToken(email);
      if (!token?.idToken) continue;

      console.log(`\nUsing account: ${email}`);
      console.log(`isMicrosoft: ${token.isMicrosoft}`);

      // 1. Try filter: { type: "inbox" } - get all inbox threads
      console.log("\n=== filter: { type: 'inbox' } ===");
      try {
        const result = await superhumanFetch(token, "/v3/userdata.getThreads", {
          method: "POST",
          body: JSON.stringify({
            filter: { type: "inbox" },
            offset: 0,
            limit: 3,
          }),
        });
        console.log("Result keys:", result ? Object.keys(result) : "null");
        if (result?.threadList?.length > 0) {
          console.log("Thread count:", result.threadList.length);
          const t = result.threadList[0];
          console.log("First thread keys:", Object.keys(t));
          if (t.thread) {
            console.log("thread keys:", Object.keys(t.thread));
            // Look for listIds
            if (t.thread.listIds) console.log("thread.listIds:", t.thread.listIds);
            // Show first message keys
            const msgKeys = Object.keys(t.thread.messages || {});
            if (msgKeys.length > 0) {
              const msg = t.thread.messages[msgKeys[0]];
              console.log("First message keys:", Object.keys(msg));
              console.log("First message labelIds:", msg.labelIds || msg.labels);
            }
          }
        }
      } catch (e) { console.log("Error:", (e as Error).message); }

      // 2. Try filter: { listId: "SH_IMPORTANT" }
      console.log("\n=== filter: { listId: 'SH_IMPORTANT' } ===");
      try {
        const result = await superhumanFetch(token, "/v3/userdata.getThreads", {
          method: "POST",
          body: JSON.stringify({
            filter: { listId: "SH_IMPORTANT" },
            offset: 0,
            limit: 3,
          }),
        });
        console.log("Result keys:", result ? Object.keys(result) : "null");
        if (result?.threadList?.length > 0) {
          console.log("Thread count:", result.threadList.length);
          const t = result.threadList[0];
          if (t.thread?.messages) {
            const msgKeys = Object.keys(t.thread.messages);
            if (msgKeys.length > 0) {
              const msg = t.thread.messages[msgKeys[0]];
              console.log("Thread subject:", msg.subject || t.thread.subject);
              console.log("Message labelIds:", msg.labelIds);
            }
          }
        }
      } catch (e) { console.log("Error:", (e as Error).message); }

      // 3. Try filter: { listId: "SH_OTHER" }
      console.log("\n=== filter: { listId: 'SH_OTHER' } ===");
      try {
        const result = await superhumanFetch(token, "/v3/userdata.getThreads", {
          method: "POST",
          body: JSON.stringify({
            filter: { listId: "SH_OTHER" },
            offset: 0,
            limit: 3,
          }),
        });
        console.log("Result keys:", result ? Object.keys(result) : "null");
        if (result?.threadList?.length > 0) {
          console.log("Thread count:", result.threadList.length);
        }
      } catch (e) { console.log("Error:", (e as Error).message); }

      // 4. Try filter: { type: "important" }
      console.log("\n=== filter: { type: 'important' } ===");
      try {
        const result = await superhumanFetch(token, "/v3/userdata.getThreads", {
          method: "POST",
          body: JSON.stringify({
            filter: { type: "important" },
            offset: 0,
            limit: 3,
          }),
        });
        console.log("Result:", result ? `threadList.length=${result.threadList?.length}` : "null");
      } catch (e) { console.log("Error:", (e as Error).message); }

      // 5. Try with no filter at all
      console.log("\n=== No filter (empty object) ===");
      try {
        const result = await superhumanFetch(token, "/v3/userdata.getThreads", {
          method: "POST",
          body: JSON.stringify({
            filter: {},
            offset: 0,
            limit: 3,
          }),
        });
        console.log("Result:", result ? `threadList.length=${result.threadList?.length}` : "null");
        if (result?.threadList?.length > 0) {
          console.log("First thread keys:", Object.keys(result.threadList[0]));
          if (result.threadList[0].thread) {
            console.log("thread keys:", Object.keys(result.threadList[0].thread));
          }
        }
      } catch (e) { console.log("Error:", (e as Error).message); }

      // Now test with the UVA Outlook account
      break;
    }
  }

  // Try UVA account specifically
  const uvaEmail = "ehu@law.virginia.edu";
  if (await hasCachedSuperhumanCredentials(uvaEmail)) {
    const token = await getCachedToken(uvaEmail);
    if (token?.idToken) {
      console.log(`\n\n=== UVA Account (${uvaEmail}, isMicrosoft: ${token.isMicrosoft}) ===`);

      console.log("\n=== filter: { listId: 'SH_IMPORTANT' } ===");
      try {
        const result = await superhumanFetch(token, "/v3/userdata.getThreads", {
          method: "POST",
          body: JSON.stringify({
            filter: { listId: "SH_IMPORTANT" },
            offset: 0,
            limit: 5,
          }),
        });
        if (result?.threadList?.length > 0) {
          console.log("Important thread count:", result.threadList.length);
          for (const t of result.threadList) {
            const msgs = t.thread?.messages || {};
            const firstMsgKey = Object.keys(msgs)[0];
            const firstMsg = msgs[firstMsgKey];
            console.log(`  - ${firstMsg?.subject || 'no subject'} (from: ${firstMsg?.from?.email || 'unknown'})`);
          }
        } else {
          console.log("Result:", result);
        }
      } catch (e) { console.log("Error:", (e as Error).message); }

      console.log("\n=== filter: { listId: 'SH_OTHER' } ===");
      try {
        const result = await superhumanFetch(token, "/v3/userdata.getThreads", {
          method: "POST",
          body: JSON.stringify({
            filter: { listId: "SH_OTHER" },
            offset: 0,
            limit: 5,
          }),
        });
        if (result?.threadList?.length > 0) {
          console.log("Other thread count:", result.threadList.length);
          for (const t of result.threadList) {
            const msgs = t.thread?.messages || {};
            const firstMsgKey = Object.keys(msgs)[0];
            const firstMsg = msgs[firstMsgKey];
            console.log(`  - ${firstMsg?.subject || 'no subject'} (from: ${firstMsg?.from?.email || 'unknown'})`);
          }
        }
      } catch (e) { console.log("Error:", (e as Error).message); }
    }
  }
}

main().catch(console.error);
