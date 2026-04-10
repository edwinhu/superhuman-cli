#!/usr/bin/env bun
/**
 * Test isLastMessageFromMe and SH_NO_REPLY on inbox threads.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const mainPage = targets.find(t =>
    t.url.includes("mail.superhuman.com") && t.type === "page" &&
    !t.url.includes("background_page") && !t.url.includes("tabs.html")
  );
  if (!mainPage) { console.error("No UI page found"); process.exit(1); }

  const client = await CDP({ port: CDP_PORT, target: mainPage.id });

  // 1. Compare isLastMessageFromMe vs SH_NO_REPLY for all inbox threads
  console.log("=== isLastMessageFromMe vs SH_NO_REPLY ===\n");
  const r1 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const userEmail = ga?.user?.emailAddress;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const threads = [];
        let bothMatch = 0;
        let onlyMethod = 0;
        let onlyLabel = 0;
        let neither = 0;

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds?.includes('INBOX')) continue;

          let isLastFromMe = null;
          try { isLastFromMe = meta.isLastMessageFromMe(); } catch (e) { isLastFromMe = 'error: ' + e.message; }

          const hasSHNoReply = meta._listIds.includes('SH_NO_REPLY');
          const isImportant = meta._listIds.includes('SH_IMPORTANT');
          const msgCount = meta.messages?.length || meta.messageIds?.length || 0;

          // Count agreement
          if (isLastFromMe === true && !hasSHNoReply) onlyMethod++;
          else if (isLastFromMe !== true && hasSHNoReply) onlyLabel++;
          else if (isLastFromMe === true && hasSHNoReply) bothMatch++;  // wait, these should be opposite
          else neither++;

          if (isImportant) {
            threads.push({
              id: meta.id,
              subject: (meta.subject || '').slice(0, 50),
              isLastFromMe,
              hasSHNoReply,
              msgCount,
              listIds: meta._listIds.filter(l => l.startsWith('SH_') || l === 'SENT'),
            });
          }
        }

        return {
          userEmail,
          totalInbox: threads.length,
          stats: { bothMatch, onlyMethod, onlyLabel, neither },
          importantSample: threads.slice(0, 15),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r1.result?.value, null, 2));

  // 2. What does SH_NO_REPLY actually mean? Check threads that have it
  console.log("\n=== SH_NO_REPLY threads in detail ===\n");
  const r2 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const userEmail = ga?.user?.emailAddress?.toLowerCase();
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const noReplyThreads = [];

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds?.includes('SH_NO_REPLY')) continue;
          if (!meta._listIds.includes('INBOX')) continue;

          let isLastFromMe = null;
          try { isLastFromMe = meta.isLastMessageFromMe(); } catch { isLastFromMe = 'error'; }

          // Get last message sender
          let lastSender = null;
          if (meta.messages && Array.isArray(meta.messages)) {
            const lastMsg = meta.messages[meta.messages.length - 1];
            if (lastMsg) {
              lastSender = lastMsg.from?.email || lastMsg.from?.emailAddress || 'unknown';
            }
          }

          noReplyThreads.push({
            id: meta.id,
            subject: (meta.subject || '').slice(0, 50),
            isLastFromMe,
            lastSender,
            msgCount: meta.messageIds?.length || 0,
            isImportant: meta._listIds.includes('SH_IMPORTANT'),
          });
        }

        return { count: noReplyThreads.length, threads: noReplyThreads };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r2.result?.value, null, 2));

  // 3. Check messages structure on a multi-message thread
  console.log("\n=== MESSAGE STRUCTURE (multi-message Important thread) ===\n");
  const r3 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const userEmail = ga?.user?.emailAddress?.toLowerCase();
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds?.includes('INBOX') || !meta._listIds.includes('SH_IMPORTANT')) continue;
          if (!meta.messages || !Array.isArray(meta.messages) || meta.messages.length < 2) continue;

          // Dump first and last message structure
          const firstMsg = meta.messages[0];
          const lastMsg = meta.messages[meta.messages.length - 1];

          const dumpMsg = (msg) => {
            if (!msg) return null;
            const result = {};
            for (const k of Object.keys(msg)) {
              const v = msg[k];
              if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                result[k] = typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '...' : v;
              } else if (Array.isArray(v)) {
                result[k] = '[Array(' + v.length + ')]';
              } else if (typeof v === 'object') {
                // One level deep for from/to
                const subKeys = Object.keys(v);
                if (subKeys.length <= 5) {
                  const sub = {};
                  for (const sk of subKeys) {
                    sub[sk] = typeof v[sk] === 'string' ? v[sk] : typeof v[sk];
                  }
                  result[k] = sub;
                } else {
                  result[k] = '[Object(' + subKeys.length + ')]';
                }
              }
            }
            return result;
          };

          return {
            threadId: meta.id,
            subject: (meta.subject || '').slice(0, 60),
            msgCount: meta.messages.length,
            firstMessage: dumpMsg(firstMsg),
            lastMessage: dumpMsg(lastMsg),
          };
        }
        return { error: "No multi-message important thread found" };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r3.result?.value, null, 2));

  // 4. Full test: ONE CDP eval that returns Important inbox threads needing reply
  console.log("\n=== COMBINED: Important + Needs Reply (one eval) ===\n");
  const r4 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const userEmail = ga?.user?.emailAddress;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const results = [];

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds) continue;
          if (!meta._listIds.includes('INBOX') || !meta._listIds.includes('SH_IMPORTANT')) continue;

          // Skip threads where user was last sender
          let isLastFromMe;
          try { isLastFromMe = meta.isLastMessageFromMe(); } catch { isLastFromMe = false; }

          // Single-message threads always count as needing reply
          const msgCount = meta.messageIds?.length || meta.messages?.length || 0;
          if (msgCount > 1 && isLastFromMe) continue;

          // Get last message sender for display
          let lastSender = null;
          if (meta.messages && Array.isArray(meta.messages) && meta.messages.length > 0) {
            const lastMsg = meta.messages[meta.messages.length - 1];
            lastSender = lastMsg?.from?.email || null;
          }

          results.push({
            id: meta.id,
            subject: (meta.subject || '').slice(0, 60),
            lastSender,
            msgCount,
            date: meta.messages?.[meta.messages.length - 1]?.date || null,
            isUnread: meta._listIds.includes('UNREAD'),
          });
        }

        // Sort by date descending
        results.sort((a, b) => (b.date || 0) - (a.date || 0));

        return {
          userEmail,
          totalImportantNeedingReply: results.length,
          threads: results.slice(0, 10),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r4.result?.value, null, 2));

  await client.close();
}

main().catch(console.error);
