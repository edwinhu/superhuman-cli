#!/usr/bin/env bun
/**
 * Dump thread metadata fields carefully (avoid deep serialization).
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

  // 1. Just get the key names first
  console.log("=== META OWN KEYS + PROTO KEYS ===\n");
  const r1 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds?.includes('INBOX')) continue;

          const ownKeys = Object.keys(meta);
          const proto = Object.getPrototypeOf(meta);
          const protoKeys = proto ? Object.getOwnPropertyNames(proto).filter(k => k !== 'constructor') : [];

          // Presenter keys
          const presenterOwn = Object.keys(presenter);
          const presenterProto = Object.getOwnPropertyNames(Object.getPrototypeOf(presenter) || {}).filter(k => k !== 'constructor');

          return {
            metaOwnKeys: ownKeys,
            metaProtoKeys: protoKeys,
            presenterOwnKeys: presenterOwn,
            presenterProtoKeys: presenterProto,
          };
        }
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r1.result?.value, null, 2));

  // 2. For one thread: dump scalar values only
  console.log("\n=== SCALAR META VALUES (1 Important thread) ===\n");
  const r2 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds?.includes('INBOX') || !meta._listIds.includes('SH_IMPORTANT')) continue;

          const scalars = {};
          for (const k of Object.keys(meta)) {
            const v = meta[k];
            if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              scalars[k] = typeof v === 'string' && v.length > 150 ? v.slice(0, 150) + '...' : v;
            } else if (Array.isArray(v)) {
              // Only include if array of primitives
              if (v.length === 0 || typeof v[0] !== 'object') {
                scalars[k] = v.length <= 20 ? v : v.slice(0, 5).concat('...' + v.length);
              } else {
                scalars[k] = '[Array(' + v.length + ') of objects]';
              }
            } else {
              scalars[k] = '[object: ' + Object.keys(v).slice(0, 10).join(', ') + ']';
            }
          }
          return scalars;
        }
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r2.result?.value, null, 2));

  // 3. Check proto getter values (scalar only)
  console.log("\n=== PROTO GETTER VALUES ===\n");
  const r3 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds?.includes('INBOX') || !meta._listIds.includes('SH_IMPORTANT')) continue;

          const proto = Object.getPrototypeOf(meta);
          if (!proto) return { error: "No proto" };

          const result = {};
          for (const k of Object.getOwnPropertyNames(proto)) {
            if (k === 'constructor') continue;
            const desc = Object.getOwnPropertyDescriptor(proto, k);
            if (desc?.get) {
              try {
                const v = meta[k];
                if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                  result[k] = typeof v === 'string' && v.length > 150 ? v.slice(0, 150) + '...' : v;
                } else if (Array.isArray(v)) {
                  result[k] = '[Array(' + v.length + ')]';
                } else if (typeof v === 'object') {
                  result[k] = '[Object: ' + Object.keys(v).slice(0, 10).join(', ') + ']';
                }
              } catch (e) {
                result[k] = '[error]';
              }
            } else if (typeof desc?.value === 'function') {
              result[k] = '[method]';
            }
          }
          return result;
        }
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r3.result?.value, null, 2));

  // 4. Check SH_NO_REPLY distribution
  console.log("\n=== SH_ LIST ID DISTRIBUTION ===\n");
  const r4 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const shIdCounts = {};
        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds) continue;
          for (const lid of meta._listIds) {
            if (lid.startsWith('SH_')) {
              shIdCounts[lid] = (shIdCounts[lid] || 0) + 1;
            }
          }
        }
        return shIdCounts;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r4.result?.value, null, 2));

  // 5. Look at contacts structure for a thread
  console.log("\n=== CONTACTS STRUCTURE ===\n");
  const r5 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const userEmail = ga?.user?.emailAddress;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        const results = [];
        let count = 0;

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds?.includes('INBOX') || !meta._listIds.includes('SH_IMPORTANT')) continue;

          // Check contacts
          const contacts = meta.contacts || meta._contacts;
          let contactData = null;
          if (contacts && Array.isArray(contacts)) {
            contactData = contacts.map(c => {
              const keys = Object.keys(c);
              const scalars = {};
              for (const k of keys) {
                const v = c[k];
                if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                  scalars[k] = v;
                } else {
                  scalars[k] = '[' + typeof v + ']';
                }
              }
              return scalars;
            });
          }

          // Check emails array
          const emails = meta.emails || meta._emails;

          // Check messages - just count and keys
          const msgs = meta.messages || meta._messages;
          let msgInfo = null;
          if (msgs && typeof msgs === 'object') {
            const msgKeys = Object.keys(msgs);
            msgInfo = { count: msgKeys.length };
          }

          // Check for any field with "from", "sender", "reply" in the name
          const interestingFields = {};
          for (const k of Object.keys(meta)) {
            const kl = k.toLowerCase();
            if (kl.includes('from') || kl.includes('sender') || kl.includes('reply') ||
                kl.includes('last') || kl.includes('count') || kl.includes('unread') ||
                kl.includes('draft') || kl.includes('sent')) {
              const v = meta[k];
              interestingFields[k] = (v === null || v === undefined || typeof v !== 'object') ? v : '[object]';
            }
          }

          results.push({
            id: meta.id,
            subject: (meta.subject || '').slice(0, 60),
            _listIds: meta._listIds,
            contacts: contactData,
            emails: emails,
            messageInfo: msgInfo,
            interestingFields,
          });

          if (++count >= 5) break;
        }

        return { userEmail, results };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r5.result?.value, null, 2));

  // 6. Check presenter-level for reply/last-sender info
  console.log("\n=== PRESENTER SCALAR VALUES ===\n");
  const r6 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const tree = ga?.threads?.identityMap;
        if (!tree?.cache) return { error: "No cache" };

        for (const [id, presenter] of Object.entries(tree.cache)) {
          const meta = presenter?.metadata || presenter?._threadModel;
          if (!meta?._listIds?.includes('INBOX') || !meta._listIds.includes('SH_IMPORTANT')) continue;

          const scalars = {};
          for (const k of Object.keys(presenter)) {
            const v = presenter[k];
            if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              scalars[k] = typeof v === 'string' && v.length > 100 ? v.slice(0, 100) + '...' : v;
            } else if (Array.isArray(v)) {
              scalars[k] = '[Array(' + v.length + ')]';
            } else if (typeof v === 'function') {
              scalars[k] = '[fn]';
            } else {
              scalars[k] = '[obj: ' + Object.keys(v).slice(0, 8).join(',') + ']';
            }
          }

          // Proto getters too
          const proto = Object.getPrototypeOf(presenter);
          const getters = {};
          if (proto) {
            for (const k of Object.getOwnPropertyNames(proto)) {
              if (k === 'constructor') continue;
              const desc = Object.getOwnPropertyDescriptor(proto, k);
              if (desc?.get) {
                try {
                  const v = presenter[k];
                  if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                    getters[k] = typeof v === 'string' && v.length > 100 ? v.slice(0, 100) + '...' : v;
                  } else if (Array.isArray(v)) {
                    getters[k] = '[Array(' + v.length + ')]';
                  } else {
                    getters[k] = '[obj: ' + Object.keys(v).slice(0, 8).join(',') + ']';
                  }
                } catch { getters[k] = '[error]'; }
              } else if (typeof desc?.value === 'function') {
                getters[k] = '[method]';
              }
            }
          }

          return { presenterScalars: scalars, presenterGetters: getters };
        }
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r6.result?.value, null, 2));

  await client.close();
}

main().catch(console.error);
