import { connectToSuperhuman } from "../superhuman-api";
import { portalInvoke } from "../portal-rpc";

const TARGET_ID = "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AXIqdBgk1EkKJ_kY4ZzlqaQABueROowAA";

async function main() {
  const conn = await connectToSuperhuman();
  if (!conn) { console.error("No connection"); process.exit(1); }

  const result = await portalInvoke(conn, "threadInternal", "listAsync", ["INBOX", { limit: 5, query: "" }]);
  const rawThreads = Array.isArray(result) ? result : Array.isArray(result?.threads) ? result.threads : [];
  
  console.log(`Got ${rawThreads.length} threads`);
  for (const item of rawThreads.slice(0, 3)) {
    const json = item?.json;
    if (!json) { console.log("item has no json, item keys:", Object.keys(item || {})); continue; }
    const itemId = json.id || item.id || item.threadId || "";
    const messages: any[] = Array.isArray(json.messages) ? json.messages
      : typeof json.messages === "object" && json.messages !== null ? Object.values(json.messages) : [];
    const msgIds = messages.map((m: any) => m.id).slice(0, 3);
    console.log("thread itemId:", itemId.substring(0, 60) + "...");
    console.log("  msg ids:", msgIds.map((id: string) => id?.substring(0, 60) + "..."));
    console.log("  target match:", itemId === TARGET_ID || messages.some((m: any) => m.id === TARGET_ID));
    console.log("  first msg keys:", messages.length > 0 ? Object.keys(messages[0]).join(", ") : "no messages");
  }
  
  await conn.client.close();
}

main().catch(console.error);
