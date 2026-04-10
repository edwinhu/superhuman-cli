#!/usr/bin/env bun
/**
 * Find what message.isInImportant() does — this is the core classifier.
 * For Gmail it checks category:personal. For Outlook, what does it check?
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find(t =>
    t.url.includes("mail.superhuman.com") && t.type === "page" &&
    !t.url.includes("background_page") && !t.url.includes("tabs.html")
  );
  if (!mainPage) { console.error("No UI page"); process.exit(1); }

  const client = await CDP({ port: CDP_PORT, target: mainPage.id });

  // 1. Get isInImportant source from a message object
  console.log("=== message.isInImportant source ===\n");
  const r1 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?.messages?.length) continue;

          const msg = meta.messages[0];
          if (msg.isInImportant) {
            return {
              source: msg.isInImportant.toString().slice(0, 2000),
            };
          }

          // Check prototype
          const proto = Object.getPrototypeOf(msg);
          if (proto?.isInImportant) {
            return {
              source: proto.isInImportant.toString().slice(0, 2000),
            };
          }

          return { error: "No isInImportant on message", msgKeys: Object.keys(msg).slice(0, 20) };
        }
        return { error: "No threads" };
      })()
    `,
    returnByValue: true,
  });
  console.log(r1.result?.value?.source || JSON.stringify(r1.result?.value, null, 2));

  // 2. Check what labelIds a message has — look for CATEGORY_PERSONAL, IMPORTANT, etc.
  console.log("\n=== Sample message labelIds ===\n");
  const r2 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const results = [];
        let count = 0;

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds?.includes('INBOX')) continue;

          for (const msg of (meta.messages || [])) {
            const isImportant = msg.isInImportant?.();
            results.push({
              threadSubject: meta.subject?.slice(0, 40),
              msgLabelIds: msg.labelIds,
              isInImportant: isImportant,
              shClassification: meta._listIds.includes('SH_IMPORTANT') ? 'IMPORTANT' : 'OTHER',
            });
            if (++count >= 8) break;
          }
          if (count >= 8) break;
        }

        return results;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r2.result?.value, null, 2));

  // 3. Find the hasImportantMessage method on thread model
  console.log("\n=== hasImportantMessage source ===\n");
  const r3 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta) continue;

          const proto = Object.getPrototypeOf(meta);
          if (proto?.hasImportantMessage) {
            return proto.hasImportantMessage.toString().slice(0, 1000);
          }
        }
        return { error: "Not found" };
      })()
    `,
    returnByValue: true,
  });
  console.log(r3.result?.value);

  await client.close();
}

main().catch(console.error);
