#!/usr/bin/env bun
/**
 * Dump ALL fields on thread metadata from Superhuman's identity map cache.
 * Goal: Find reply status, last sender, message history — anything beyond _listIds.
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

  // 1. Dump ALL keys on a few thread presenters and their metadata
  console.log("=== FULL THREAD STRUCTURE (3 Important inbox threads) ===\n");
  const result1 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const samples = [];
        let count = 0;

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds) continue;
          if (!meta._listIds.includes('INBOX') || !meta._listIds.includes('SH_IMPORTANT')) continue;

          // Deep dump of the presenter object
          const presenterKeys = Object.keys(presenter);
          const presenterProtoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(presenter) || {});

          // Deep dump of metadata
          const metaKeys = Object.keys(meta);
          const metaProtoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(meta) || {});

          // Collect ALL values (shallow)
          const metaValues = {};
          for (const k of metaKeys) {
            const v = meta[k];
            if (v === null || v === undefined) {
              metaValues[k] = v;
            } else if (Array.isArray(v)) {
              metaValues[k] = v.length <= 20 ? v : v.slice(0, 5).concat(['...' + v.length + ' total']);
            } else if (typeof v === 'object') {
              metaValues[k] = { _type: v.constructor?.name, _keys: Object.keys(v).slice(0, 30) };
            } else if (typeof v === 'string' && v.length > 200) {
              metaValues[k] = v.slice(0, 200) + '...';
            } else {
              metaValues[k] = v;
            }
          }

          // Check for getters on the prototype
          const getterValues = {};
          for (const k of metaProtoKeys) {
            if (k === 'constructor') continue;
            try {
              const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(meta), k);
              if (desc?.get) {
                const v = meta[k];
                if (v === null || v === undefined) {
                  getterValues[k] = v;
                } else if (Array.isArray(v)) {
                  getterValues[k] = v.length <= 10 ? v : v.slice(0, 3).concat(['...' + v.length + ' total']);
                } else if (typeof v === 'object') {
                  getterValues[k] = { _type: v.constructor?.name, _keys: Object.keys(v).slice(0, 20) };
                } else if (typeof v === 'string' && v.length > 200) {
                  getterValues[k] = v.slice(0, 200) + '...';
                } else {
                  getterValues[k] = v;
                }
              } else if (typeof desc?.value === 'function') {
                getterValues[k] = '[method]';
              }
            } catch (e) {
              getterValues[k] = '[error: ' + e.message + ']';
            }
          }

          samples.push({
            id: meta.id,
            subject: meta.subject?.slice(0, 80),
            presenterKeys,
            presenterProtoKeys: presenterProtoKeys.filter(k => k !== 'constructor'),
            metaOwnKeys: metaKeys,
            metaProtoKeys: metaProtoKeys.filter(k => k !== 'constructor'),
            metaValues,
            metaGetterValues: getterValues,
          });

          if (++count >= 3) break;
        }

        return { sampleCount: samples.length, samples };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(result1.result?.value, null, 2));

  // 2. Check presenter-level fields (not just metadata)
  console.log("\n\n=== PRESENTER-LEVEL FIELDS ===\n");
  const result2 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds?.includes('INBOX')) continue;

          // Dump presenter own properties
          const values = {};
          for (const k of Object.keys(presenter)) {
            const v = presenter[k];
            if (v === null || v === undefined) {
              values[k] = v;
            } else if (typeof v === 'function') {
              values[k] = '[function]';
            } else if (Array.isArray(v)) {
              values[k] = { _array: true, length: v.length, sample: v.slice(0, 3).map(x => typeof x === 'object' ? Object.keys(x || {}).slice(0, 10) : x) };
            } else if (typeof v === 'object') {
              values[k] = { _type: v.constructor?.name, _keys: Object.keys(v).slice(0, 20) };
            } else if (typeof v === 'string' && v.length > 100) {
              values[k] = v.slice(0, 100) + '...';
            } else {
              values[k] = v;
            }
          }

          // Presenter proto methods
          const proto = Object.getPrototypeOf(presenter);
          const protoNames = proto ? Object.getOwnPropertyNames(proto).filter(k => k !== 'constructor') : [];

          return {
            id: meta.id,
            subject: meta.subject?.slice(0, 60),
            presenterOwnValues: values,
            presenterProtoMethods: protoNames.slice(0, 40),
          };
        }
        return { error: "No inbox threads" };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(result2.result?.value, null, 2));

  // 3. Look for contacts, lastSender, replied, etc. on metadata
  console.log("\n\n=== CONTACTS & REPLY INDICATORS ===\n");
  const result3 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const userEmail = ga?.user?.emailAddress;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const threads = [];
        let count = 0;

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds?.includes('INBOX') || !meta._listIds.includes('SH_IMPORTANT')) continue;

          // Dig into contacts
          const contacts = meta.contacts || meta._contacts;
          let contactInfo = null;
          if (contacts) {
            if (Array.isArray(contacts)) {
              contactInfo = contacts.map(c => ({
                keys: Object.keys(c).slice(0, 15),
                email: c.email || c.emailAddress || c.address,
                name: c.name || c.displayName,
              }));
            } else {
              contactInfo = { _type: typeof contacts, _keys: Object.keys(contacts).slice(0, 15) };
            }
          }

          // Check for messages or messageCount
          const messages = meta.messages || meta._messages;
          let messageInfo = null;
          if (messages) {
            if (typeof messages === 'object') {
              const msgKeys = Object.keys(messages);
              messageInfo = { count: msgKeys.length, keys: msgKeys.slice(0, 5) };
              // Look at first message structure
              if (msgKeys.length > 0) {
                const firstMsg = messages[msgKeys[0]];
                if (firstMsg && typeof firstMsg === 'object') {
                  messageInfo.firstMsgKeys = Object.keys(firstMsg).slice(0, 20);
                  messageInfo.firstMsgFrom = firstMsg.from || firstMsg.sender;
                }
              }
              // Look at last message
              if (msgKeys.length > 1) {
                const lastMsg = messages[msgKeys[msgKeys.length - 1]];
                if (lastMsg && typeof lastMsg === 'object') {
                  messageInfo.lastMsgFrom = lastMsg.from || lastMsg.sender;
                }
              }
            }
          }

          // Look for any reply-related fields
          const replyFields = {};
          for (const k of Object.keys(meta)) {
            const kl = k.toLowerCase();
            if (kl.includes('reply') || kl.includes('respond') || kl.includes('sent') ||
                kl.includes('sender') || kl.includes('last') || kl.includes('from') ||
                kl.includes('contact') || kl.includes('message') || kl.includes('count') ||
                kl.includes('snippet') || kl.includes('no_reply') || kl.includes('noreply')) {
              const v = meta[k];
              replyFields[k] = typeof v === 'object' ? (Array.isArray(v) ? v.slice(0, 3) : Object.keys(v || {}).slice(0, 10)) : v;
            }
          }

          threads.push({
            id: meta.id,
            subject: meta.subject?.slice(0, 60),
            _listIds: meta._listIds,
            contacts: contactInfo,
            messages: messageInfo,
            replyFields,
            hasSnippet: !!meta.snippet || !!meta._snippet,
            snippet: (meta.snippet || meta._snippet || '').slice(0, 100),
          });

          if (++count >= 5) break;
        }

        return { userEmail, threadCount: threads.length, threads };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(result3.result?.value, null, 2));

  // 4. Check if SH_NO_REPLY is in _listIds for any threads
  console.log("\n\n=== SH_NO_REPLY DISTRIBUTION ===\n");
  const result4 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        let noReplyCount = 0;
        let inboxNoReply = 0;
        let importantNoReply = 0;
        const samples = [];

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds) continue;

          if (meta._listIds.includes('SH_NO_REPLY')) {
            noReplyCount++;
            if (meta._listIds.includes('INBOX')) {
              inboxNoReply++;
              if (meta._listIds.includes('SH_IMPORTANT') && samples.length < 5) {
                samples.push({
                  id: meta.id,
                  subject: meta.subject?.slice(0, 60),
                  _listIds: meta._listIds,
                });
              }
            }
            if (meta._listIds.includes('SH_IMPORTANT')) importantNoReply++;
          }
        }

        // Also check all unique SH_ prefixed list IDs
        const allShIds = new Set();
        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds) continue;
          for (const lid of meta._listIds) {
            if (lid.startsWith('SH_')) allShIds.add(lid);
          }
        }

        return {
          noReplyCount,
          inboxNoReply,
          importantNoReply,
          samples,
          allSuperhumanListIds: [...allShIds].sort(),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(result4.result?.value, null, 2));

  await client.close();
}

main().catch(console.error);
