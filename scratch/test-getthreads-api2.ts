#!/usr/bin/env bun
/**
 * Test userdata.getThreads with correct token format.
 */

import { loadTokensFromDisk, getCachedToken, hasCachedSuperhumanCredentials, getCachedAccounts, superhumanFetch } from "../src/token-api";

async function main() {
  await loadTokensFromDisk();
  const accounts = getCachedAccounts();

  for (const email of accounts) {
    if (!(await hasCachedSuperhumanCredentials(email))) continue;
    const token = await getCachedToken(email);
    if (!token?.idToken) continue;

    console.log(`\n=== Account: ${email} (isMicrosoft: ${token.isMicrosoft}) ===`);

    // The token for superhumanFetch is the idToken (JWT)
    const shToken = token.idToken;

    // 1. Try filter: { type: "reminder" } - known working
    console.log("\n--- filter: { type: 'reminder' } (known working) ---");
    try {
      const result = await superhumanFetch(shToken, "/v3/userdata.getThreads", {
        method: "POST",
        body: JSON.stringify({ filter: { type: "reminder" }, offset: 0, limit: 2 }),
      });
      console.log("Result:", result ? `threadList: ${result.threadList?.length}` : "null");
    } catch (e) { console.log("Error:", (e as Error).message.slice(0, 200)); }

    // 2. Try filter: { listId: "SH_IMPORTANT" }
    console.log("\n--- filter: { listId: 'SH_IMPORTANT' } ---");
    try {
      const result = await superhumanFetch(shToken, "/v3/userdata.getThreads", {
        method: "POST",
        body: JSON.stringify({ filter: { listId: "SH_IMPORTANT" }, offset: 0, limit: 3 }),
      });
      console.log("Result:", result ? `threadList: ${result.threadList?.length}` : "null");
      if (result?.threadList?.length > 0) {
        const t = result.threadList[0];
        console.log("Thread keys:", Object.keys(t));
        if (t.thread) {
          console.log("thread keys:", Object.keys(t.thread));
          const msgs = t.thread.messages || {};
          const firstKey = Object.keys(msgs)[0];
          if (firstKey) {
            const msg = msgs[firstKey];
            console.log("Message keys:", Object.keys(msg));
            console.log("Subject:", msg.subject);
            console.log("From:", msg.from);
            console.log("LabelIds:", msg.labelIds);
          }
        }
      }
    } catch (e) { console.log("Error:", (e as Error).message.slice(0, 200)); }

    // 3. Try filter: { listId: "SH_OTHER" }
    console.log("\n--- filter: { listId: 'SH_OTHER' } ---");
    try {
      const result = await superhumanFetch(shToken, "/v3/userdata.getThreads", {
        method: "POST",
        body: JSON.stringify({ filter: { listId: "SH_OTHER" }, offset: 0, limit: 3 }),
      });
      console.log("Result:", result ? `threadList: ${result.threadList?.length}` : "null");
      if (result?.threadList?.length > 0) {
        const t = result.threadList[0];
        if (t.thread?.messages) {
          const firstKey = Object.keys(t.thread.messages)[0];
          if (firstKey) {
            console.log("Subject:", t.thread.messages[firstKey].subject);
          }
        }
      }
    } catch (e) { console.log("Error:", (e as Error).message.slice(0, 200)); }

    // 4. Try filter: { type: "inbox" }
    console.log("\n--- filter: { type: 'inbox' } ---");
    try {
      const result = await superhumanFetch(shToken, "/v3/userdata.getThreads", {
        method: "POST",
        body: JSON.stringify({ filter: { type: "inbox" }, offset: 0, limit: 3 }),
      });
      console.log("Result:", result ? `threadList: ${result.threadList?.length}` : "null");
    } catch (e) { console.log("Error:", (e as Error).message.slice(0, 200)); }

    // 5. Try with explicit INBOX listId
    console.log("\n--- filter: { listId: 'INBOX' } ---");
    try {
      const result = await superhumanFetch(shToken, "/v3/userdata.getThreads", {
        method: "POST",
        body: JSON.stringify({ filter: { listId: "INBOX" }, offset: 0, limit: 3 }),
      });
      console.log("Result:", result ? `threadList: ${result.threadList?.length}` : "null");
    } catch (e) { console.log("Error:", (e as Error).message.slice(0, 200)); }
  }
}

main().catch(console.error);
