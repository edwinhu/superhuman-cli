#!/usr/bin/env bun
/**
 * List all CDP pages to find the correct Superhuman tab
 */

import CDP from "chrome-remote-interface";

async function listPages() {
  console.log("🔍 Discovering Superhuman pages...\n");

  const targets = await CDP.List({ port: 9333 });

  console.log(`Found ${targets.length} pages:\n`);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    console.log(`[${i}] ${target.type}`);
    console.log(`    Title: ${target.title}`);
    console.log(`    URL: ${target.url}`);
    console.log(`    ID: ${target.id}`);
    console.log("");
  }

  console.log("\n💡 Tip: Look for the page with Superhuman's main UI");
  console.log("   Usually has 'Superhuman' in the title or URL: mail.superhuman.com\n");
}

listPages().catch(console.error);
