#!/usr/bin/env bun
/**
 * Get the MS Graph KQL query for SH_IMPORTANT on the UVA Outlook account.
 * Check if it differs from Gmail's category:personal approach.
 */

import CDP from "chrome-remote-interface";

const CDP_PORT = 9400;

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });

  // Check all pages — UVA account might have its own page
  console.log("=== Available pages ===\n");
  for (const t of targets) {
    if (t.type === "page" || t.type === "iframe") {
      console.log(`  [${t.type}] ${t.url.slice(0, 100)}`);
    }
  }

  const mainPage = targets.find(t =>
    t.url.includes("mail.superhuman.com") && t.type === "page" &&
    !t.url.includes("background_page") && !t.url.includes("tabs.html")
  );
  if (!mainPage) { console.error("No UI page"); process.exit(1); }

  const client = await CDP({ port: CDP_PORT, target: mainPage.id });

  // 1. Check which account is active and find UVA account
  console.log("=== Active account + account list ===\n");
  const r1 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const activeEmail = ga?.user?.emailAddress;
        const accountList = ga?.accountList;

        const accounts = accountList?.map(a => ({
          email: a?.user?.emailAddress || a?.email,
          isMicrosoft: a?.user?._provider === 'microsoft' || a?.user?._provider === 'outlook',
          hasListRouter: !!a?.listRouter,
          hasThreads: !!a?.threads,
        })) || [];

        return { activeEmail, accounts };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r1.result?.value, null, 2));

  // 2. Get KQL for active account first
  console.log("\n=== getMicrosoftSearchQueryForSplit (active account) ===\n");
  const r2 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr?.getMicrosoftSearchQueryForSplit) return { error: "No method" };

        const results = {};
        for (const id of ['SH_IMPORTANT', 'SH_OTHER']) {
          try {
            results[id] = lr.getMicrosoftSearchQueryForSplit(id);
          } catch (e) {
            results[id] = { error: e.message };
          }
        }

        // Also get the function source to understand the logic
        results._source = lr.getMicrosoftSearchQueryForSplit.toString().slice(0, 2000);

        return results;
      })()
    `,
    returnByValue: true,
  });
  console.log("SH_IMPORTANT KQL:", r2.result?.value?.SH_IMPORTANT);
  console.log("\nSH_OTHER KQL:", r2.result?.value?.SH_OTHER);
  console.log("\nSource:", r2.result?.value?._source);

  // 3. Try to access UVA account's listRouter
  console.log("\n=== UVA account listRouter ===\n");
  const r3 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const accountList = ga?.accountList;
        if (!accountList) return { error: "No accountList" };

        const uva = accountList.find(a => {
          const email = a?.user?.emailAddress || a?.email || '';
          return email.includes('virginia.edu');
        });
        if (!uva) return { error: "UVA account not found" };

        const email = uva?.user?.emailAddress;
        const provider = uva?.user?._provider;
        const lr = uva?.listRouter;

        if (!lr) return { email, provider, hasListRouter: false };

        // Get KQL queries
        const results = { email, provider };

        if (lr.getMicrosoftSearchQueryForSplit) {
          try {
            results.SH_IMPORTANT_KQL = lr.getMicrosoftSearchQueryForSplit('SH_IMPORTANT');
          } catch (e) {
            results.SH_IMPORTANT_KQL_error = e.message;
          }
          try {
            results.SH_OTHER_KQL = lr.getMicrosoftSearchQueryForSplit('SH_OTHER');
          } catch (e) {
            results.SH_OTHER_KQL_error = e.message;
          }
        } else {
          results.noMicrosoftMethod = true;
        }

        // Also get Gmail query for comparison
        if (lr.approximateGmailSearch) {
          try {
            results.SH_IMPORTANT_Gmail = lr.approximateGmailSearch('SH_IMPORTANT');
          } catch (e) {
            results.SH_IMPORTANT_Gmail_error = e.message;
          }
        }

        // Get the important definition
        if (lr.getImportantDefinition) {
          try {
            const def = lr.getImportantDefinition();
            results.importantDefinition = typeof def === 'string' ? def : String(def);
          } catch (e) {
            results.importantDefinition_error = e.message;
          }
        }

        // Get splits
        if (lr._splits) {
          results.splits = lr._splits.map(s => ({
            id: s.id,
            name: s.matcher?.name,
            isDisabled: s.isDisabled,
            leaveThreadsInImportantOther: s.leaveThreadsInImportantOther,
            query: s.matcher?.query?.slice(0, 100),
          }));
        }

        // Get settings
        if (lr._settings?._cache?.splitInboxes) {
          results.splitInboxCount = lr._settings._cache.splitInboxes.length;
          results.restrictiveImportant = lr._settings._cache.restrictiveImportant;
        }

        return results;
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r3.result?.value, null, 2));

  // 4. Get the full source of getMicrosoftSearchQueryForSplit and approximateGmailSearch
  console.log("\n=== approximateGmailSearch source ===\n");
  const r4 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr) return { error: "No listRouter" };

        return {
          approximateGmailSearch: lr.approximateGmailSearch.toString().slice(0, 3000),
          getMicrosoftSearchQueryForSplit: lr.getMicrosoftSearchQueryForSplit.toString().slice(0, 3000),
          getImportantDefinition: lr.getImportantDefinition.toString().slice(0, 1000),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log("approximateGmailSearch:\n", r4.result?.value?.approximateGmailSearch);
  console.log("\ngetMicrosoftSearchQueryForSplit:\n", r4.result?.value?.getMicrosoftSearchQueryForSplit);
  console.log("\ngetImportantDefinition:\n", r4.result?.value?.getImportantDefinition);

  // 5. Check the fromMeFilter — this is what Microsoft uses instead of category:personal
  console.log("\n=== fromMeFilter for UVA ===\n");
  const r5 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const accountList = ga?.accountList;
        if (!accountList) return { error: "No accountList" };

        const uva = accountList.find(a => {
          const email = a?.user?.emailAddress || a?.email || '';
          return email.includes('virginia.edu');
        });
        if (!uva?.listRouter) return { error: "No UVA listRouter" };

        const lr = uva.listRouter;

        // fromMeFilter
        if (lr.fromMeFilter) {
          try {
            const filter = lr.fromMeFilter();
            return {
              fromMeFilter: typeof filter === 'string' ? filter : String(filter),
              fromMeFilterType: typeof filter,
              fromMeFilterKeys: filter && typeof filter === 'object' ? Object.keys(filter) : null,
            };
          } catch (e) {
            return { error: e.message };
          }
        }
        return { error: "No fromMeFilter" };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r5.result?.value, null, 2));

  await client.close();
}

main().catch(console.error);
