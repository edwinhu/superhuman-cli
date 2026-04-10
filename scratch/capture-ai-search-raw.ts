#!/usr/bin/env bun
/**
 * Make a real ai.askAIProxy call and dump ALL SSE event fields.
 * Purpose: find if thread IDs are included in any SSE field we're ignoring.
 */
import { loadTokensFromDisk, getCachedToken } from "../src/token-api";

const QUERY = process.argv[2] || "invoice";

async function main() {
  await loadTokensFromDisk();

  // Get any cached account
  const { getCachedAccounts } = await import("../src/token-api");
  const accounts = getCachedAccounts();
  if (accounts.length === 0) {
    console.error("No cached accounts");
    process.exit(1);
  }

  const email = accounts[0];
  console.log(`Using account: ${email}`);

  const token = await getCachedToken(email);
  if (!token?.superhumanToken) {
    console.error("No Superhuman token");
    process.exit(1);
  }

  const shToken = token.superhumanToken.token;
  const userPrefix = token.userPrefix || "TEST";

  // Build minimal payload (from askAISearch in token-api.ts)
  const sessionId = `${userPrefix}-${Date.now().toString(36)}`;
  const questionEventId = `${userPrefix}-${Date.now().toString(36)}-q`;

  const payload = {
    session_id: sessionId,
    question_event_id: questionEventId,
    query: QUERY,
    user: {
      email,
      provider_id: email,
      name: "",
      company: "",
      position: "",
    },
    chat_history: [],
    current_thread_id: "",
    current_thread_messages: [],
    local_datetime: new Date().toISOString().replace("Z", "+00:00").replace(/\.\d+/, ""),
    available_skills: ["filter", "schedule", "multiMessage", "draft", "displayThoughts"],
  };

  console.log(`\nQuerying: "${QUERY}"`);
  console.log("Payload:", JSON.stringify(payload, null, 2));

  const url = "https://mail.superhuman.com/~backend/v3/ai.askAIProxy";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${shToken}`,
      "Content-Type": "text/plain;charset=UTF-8",
    },
    body: JSON.stringify(payload),
  });

  console.log(`\nHTTP ${resp.status} ${resp.statusText}`);

  const text = await resp.text();

  console.log("\n=== RAW SSE EVENTS ===");
  const allFields = new Set<string>();
  const threadIds = new Set<string>();

  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const jsonStr = line.substring(6).trim();
    if (!jsonStr || jsonStr === "[DONE]" || jsonStr === "END") continue;

    try {
      const data = JSON.parse(jsonStr);
      // Track all top-level keys
      for (const k of Object.keys(data)) allFields.add(k);

      // Look for anything that looks like a thread ID (Superhuman thread IDs are hex strings)
      const str = JSON.stringify(data);
      const threadMatches = str.match(/"thread_id[s]?"[:\s]+"([^"]+)"/g) || [];
      for (const m of threadMatches) {
        const id = m.match(/"([a-f0-9]+)"/)?.[1];
        if (id) threadIds.add(id);
      }

      // Print each event with all its fields
      const preview: Record<string, any> = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') preview[k] = v.slice(0, 100);
        else preview[k] = v;
      }
      console.log(JSON.stringify(preview));
    } catch {}
  }

  console.log("\n=== SUMMARY ===");
  console.log("All SSE event fields:", [...allFields].join(", "));
  console.log("Thread IDs found:", [...threadIds].join(", ") || "(none)");

  // Also print the full last content
  let finalContent = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const jsonStr = line.substring(6).trim();
    if (!jsonStr || jsonStr === "[DONE]") continue;
    try {
      const data = JSON.parse(jsonStr);
      if (typeof data.content === "string") finalContent = data.content;
    } catch {}
  }
  console.log("\nFinal content:\n" + finalContent);
}

main().catch(console.error);
