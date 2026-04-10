#!/usr/bin/env bun
/**
 * Get the static getListIdsForThread source — the actual classification logic.
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

  // 1. Get the static method source
  console.log("=== ListRouter.getListIdsForThread source ===\n");
  const r1 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr) return { error: "No listRouter" };

        const LR = lr.constructor;
        if (LR.getListIdsForThread) {
          return LR.getListIdsForThread.toString().slice(0, 5000);
        }
        return { error: "No static getListIdsForThread" };
      })()
    `,
    returnByValue: true,
  });
  console.log(r1.result?.value);

  // 2. Also check the disk.list.rebuildListIds logic
  console.log("\n=== disk.list.rebuildListIds source ===\n");
  const r2 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const disk = ga?.disk;
        if (!disk?.list?.rebuildListIds) return { error: "No method" };

        return disk.list.rebuildListIds.toString().slice(0, 3000);
      })()
    `,
    returnByValue: true,
  });
  console.log(r2.result?.value);

  // 3. Check disk.thread.fixEmptyListIds
  console.log("\n=== disk.thread.fixEmptyListIds source ===\n");
  const r3 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const disk = ga?.disk;
        if (!disk?.thread?.fixEmptyListIds) return { error: "No method" };

        return disk.thread.fixEmptyListIds.toString().slice(0, 3000);
      })()
    `,
    returnByValue: true,
  });
  console.log(r3.result?.value);

  await client.close();
}

main().catch(console.error);
