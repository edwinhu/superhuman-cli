import { connectToSuperhuman } from "../superhuman-api";
import { portalInvoke } from "../portal-rpc";

const TARGET_ID = "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AXIqdBgk1EkKJ_kY4ZzlqaQABueROowAA";

async function main() {
  const conn = await connectToSuperhuman();
  if (!conn) { console.error("No connection"); process.exit(1); }

  const result = await portalInvoke(conn, "threadInternal", "listAsync", ["INBOX", { limit: 10, query: "" }]);
  const rawThreads = Array.isArray(result) ? result : Array.isArray(result?.threads) ? result.threads : [];
  
  for (const item of rawThreads) {
    const json = item?.json;
    if (!json) continue;
    const messages: any[] = Array.isArray(json.messages) ? json.messages
      : typeof json.messages === "object" && json.messages !== null ? Object.values(json.messages) : [];
    
    const isMatch = messages.some((m: any) => m.id === TARGET_ID);
    if (!isMatch) continue;
    
    console.log("FOUND THREAD!");
    console.log("Thread ID:", json.id);
    console.log("Message count:", messages.length);
    for (const m of messages) {
      console.log("  Message:", m.id?.substring(0, 50));
      console.log("    has body:", !!m.body, "has snippet:", !!m.snippet);
      console.log("    body:", (m.body || m.snippet || "").substring(0, 100));
      console.log("    keys:", Object.keys(m).join(", "));
    }
    break;
  }
  
  await conn.client.close();
}

main().catch(console.error);
