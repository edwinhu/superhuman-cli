#!/usr/bin/env bun
/**
 * Investigate how Superhuman stores AI classification on Outlook messages.
 * Check: categories, extended properties, flags, and CDP cache.
 */

import { loadTokensFromDisk, getCachedToken, getCachedAccounts } from "../src/token-api";

async function msGraphFetch(accessToken: string, path: string) {
  const url = `https://graph.microsoft.com/v1.0${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`MS Graph ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

async function main() {
  await loadTokensFromDisk();

  const uvaEmail = "ehu@law.virginia.edu";
  const token = await getCachedToken(uvaEmail);
  if (!token?.accessToken) {
    console.error("No UVA token available");
    return;
  }

  console.log(`=== UVA Account: ${uvaEmail} ===\n`);

  // 1. Get inbox messages with categories and extended properties
  console.log("=== 1. Inbox messages with categories ===\n");
  try {
    const result = await msGraphFetch(token.accessToken,
      `/me/mailFolders/Inbox/messages?$top=10&$select=id,subject,from,categories,flag,inferenceClassification,receivedDateTime&$orderby=receivedDateTime desc`
    );
    for (const msg of (result.value || [])) {
      console.log(`  Subject: ${(msg.subject || '').slice(0, 60)}`);
      console.log(`  Categories: ${JSON.stringify(msg.categories)}`);
      console.log(`  Flag: ${JSON.stringify(msg.flag)}`);
      console.log(`  InferenceClassification: ${msg.inferenceClassification}`);
      console.log();
    }
  } catch (e) {
    console.log("Error:", (e as Error).message);
  }

  // 2. Check for single-value extended properties (MAPI properties Superhuman might use)
  console.log("=== 2. Messages with singleValueExtendedProperties ===\n");
  try {
    // Get messages with ALL extended properties expanded
    const result = await msGraphFetch(token.accessToken,
      `/me/mailFolders/Inbox/messages?$top=5&$select=id,subject&$expand=singleValueExtendedProperties&$orderby=receivedDateTime desc`
    );
    for (const msg of (result.value || [])) {
      console.log(`  Subject: ${(msg.subject || '').slice(0, 60)}`);
      console.log(`  Extended props: ${JSON.stringify(msg.singleValueExtendedProperties)}`);
      console.log();
    }
  } catch (e) {
    console.log("Error:", (e as Error).message);
  }

  // 3. Check for multi-value extended properties
  console.log("=== 3. Messages with multiValueExtendedProperties ===\n");
  try {
    const result = await msGraphFetch(token.accessToken,
      `/me/mailFolders/Inbox/messages?$top=5&$select=id,subject&$expand=multiValueExtendedProperties&$orderby=receivedDateTime desc`
    );
    for (const msg of (result.value || [])) {
      console.log(`  Subject: ${(msg.subject || '').slice(0, 60)}`);
      console.log(`  Multi-value props: ${JSON.stringify(msg.multiValueExtendedProperties)}`);
      console.log();
    }
  } catch (e) {
    console.log("Error:", (e as Error).message);
  }

  // 4. Check for specific known MAPI property IDs that mail clients use for categories
  console.log("=== 4. Check specific MAPI properties ===\n");
  // Common MAPI props: Keywords (PS_PUBLIC_STRINGS), Categories
  const mapiProps = [
    "String {00020329-0000-0000-C000-000000000046} Name Keywords",  // Keywords/Categories
    "String {00062008-0000-0000-C000-000000000046} Name SuperhumanLabel",  // Custom guess
  ];
  for (const prop of mapiProps) {
    try {
      const result = await msGraphFetch(token.accessToken,
        `/me/mailFolders/Inbox/messages?$top=3&$select=id,subject&$filter=singleValueExtendedProperties/any(ep: ep/id eq '${prop}' and ep/value ne null)&$expand=singleValueExtendedProperties($filter=id eq '${prop}')`
      );
      console.log(`  Property "${prop.slice(0, 50)}...": ${(result.value || []).length} messages`);
      for (const msg of (result.value || []).slice(0, 2)) {
        console.log(`    ${(msg.subject || '').slice(0, 50)}: ${JSON.stringify(msg.singleValueExtendedProperties)}`);
      }
    } catch (e) {
      console.log(`  Property "${prop.slice(0, 50)}...": Error - ${(e as Error).message.slice(0, 100)}`);
    }
  }

  // 5. Check if any messages have non-empty categories
  console.log("\n=== 5. Messages with non-empty categories (all folders) ===\n");
  try {
    const result = await msGraphFetch(token.accessToken,
      `/me/messages?$top=20&$select=id,subject,categories,parentFolderId&$filter=categories/any(c: c ne null)&$orderby=receivedDateTime desc`
    );
    console.log(`  Messages with categories: ${(result.value || []).length}`);
    for (const msg of (result.value || []).slice(0, 10)) {
      console.log(`    ${(msg.subject || '').slice(0, 50)}: ${JSON.stringify(msg.categories)}`);
    }
  } catch (e) {
    console.log("Error:", (e as Error).message.slice(0, 200));
  }

  // 6. List all mail folders to see if Superhuman created any
  console.log("\n=== 6. All mail folders ===\n");
  try {
    const result = await msGraphFetch(token.accessToken,
      `/me/mailFolders?$top=50&$select=id,displayName,totalItemCount,childFolderCount`
    );
    for (const folder of (result.value || [])) {
      console.log(`  ${folder.displayName} (${folder.totalItemCount} items, ${folder.childFolderCount} children)`);
      // Check child folders
      if (folder.childFolderCount > 0) {
        try {
          const children = await msGraphFetch(token.accessToken,
            `/me/mailFolders/${folder.id}/childFolders?$select=displayName,totalItemCount`
          );
          for (const child of (children.value || [])) {
            console.log(`    └─ ${child.displayName} (${child.totalItemCount} items)`);
          }
        } catch { /* skip */ }
      }
    }
  } catch (e) {
    console.log("Error:", (e as Error).message.slice(0, 200));
  }

  // 7. Check for Superhuman-specific folders
  console.log("\n=== 7. Search for Superhuman/AI folders ===\n");
  try {
    const result = await msGraphFetch(token.accessToken,
      `/me/mailFolders?$filter=startsWith(displayName, 'Superhuman') or startsWith(displayName, 'AI') or startsWith(displayName, '[Superhuman]')`
    );
    console.log(`  Found: ${(result.value || []).length} folders`);
    for (const folder of (result.value || [])) {
      console.log(`    ${folder.displayName} (${folder.totalItemCount} items)`);
    }
  } catch (e) {
    console.log("Error:", (e as Error).message.slice(0, 200));
  }

  // 8. Check outlook categories (color categories defined at mailbox level)
  console.log("\n=== 8. Outlook master category list ===\n");
  try {
    const result = await msGraphFetch(token.accessToken,
      `/me/outlook/masterCategories`
    );
    for (const cat of (result.value || [])) {
      console.log(`  ${cat.displayName} (color: ${cat.color})`);
    }
  } catch (e) {
    console.log("Error:", (e as Error).message.slice(0, 200));
  }
}

main().catch(console.error);
