#!/usr/bin/env bun
/**
 * Dig into the ie.d helper that generates KQL queries.
 * Confirm that Important/Other are indistinguishable in KQL for Outlook.
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

  // 1. Trace what getMicrosoftSearchQueryForSplit actually does differently for IMPORTANT vs OTHER
  console.log("=== Comparing KQL queries character by character ===\n");
  const r1 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr) return { error: "No listRouter" };

        const important = lr.getMicrosoftSearchQueryForSplit('SH_IMPORTANT');
        const other = lr.getMicrosoftSearchQueryForSplit('SH_OTHER');

        return {
          areIdentical: important === other,
          importantLength: important?.length,
          otherLength: other?.length,
          important: important,
          other: other,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r1.result?.value, null, 2));

  // 2. Check the recalculateListIds source — how does it classify for Microsoft?
  console.log("\n=== recalculateListIds source ===\n");
  const r2 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr) return { error: "No listRouter" };

        return lr.recalculateListIds.toString().slice(0, 3000);
      })()
    `,
    returnByValue: true,
  });
  console.log(r2.result?.value);

  // 3. Check what forThread does — this is likely where per-thread classification happens
  console.log("\n=== forThread source ===\n");
  const r3 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr) return { error: "No listRouter" };

        return lr.forThread.toString().slice(0, 3000);
      })()
    `,
    returnByValue: true,
  });
  console.log(r3.result?.value);

  // 4. Get the ie module functions — find ie.b (gmail search builder) and ie.d (kql builder)
  console.log("\n=== Helper function sources ===\n");
  const r4 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr) return { error: "No listRouter" };

        // The methods reference ie.b and ie.d — these are module-scoped.
        // Try to find them via the prototype method references.
        const proto = Object.getPrototypeOf(lr);

        // Get the full class source to find the module references
        const classSource = proto.constructor.toString();

        return {
          classConstructorSource: classSource.slice(0, 1000),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r4.result?.value, null, 2));

  // 5. Try accessing ie.d directly by checking what the method calls
  console.log("\n=== Tracing getMicrosoftSearchQueryForSplit call ===\n");
  const r5 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr) return { error: "No listRouter" };

        // Monkey-patch to trace the call
        const origMethod = lr.getMicrosoftSearchQueryForSplit.bind(lr);

        // Get meAddresses
        const user = lr._di?.get?.('user');
        const meAddresses = user?.getMeAddresses?.();

        return {
          meAddresses: meAddresses,
          splitsCount: lr._splits?.length,
          activeSplits: lr._splits?.filter(s => !s.isDisabled).map(s => ({
            id: s.id,
            name: s.matcher?.name,
            leaveInImportantOther: s.leaveThreadsInImportantOther,
          })),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r5.result?.value, null, 2));

  // 6. Check how the forThread method classifies — does it use inferenceClassification for MS?
  console.log("\n=== _populateListIds source ===\n");
  const r6 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr?._populateListIds) return { error: "No _populateListIds" };

        return lr._populateListIds.toString().slice(0, 5000);
      })()
    `,
    returnByValue: true,
  });
  console.log(r6.result?.value);

  // 7. Check _fixEmptyListIds
  console.log("\n=== _fixEmptyListIds source ===\n");
  const r7 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const lr = ga?.listRouter;
        if (!lr?._fixEmptyListIds) return { error: "No method" };

        return lr._fixEmptyListIds.toString().slice(0, 3000);
      })()
    `,
    returnByValue: true,
  });
  console.log(r7.result?.value);

  // 8. Check the UVA account via accountList — does it have different split settings?
  console.log("\n=== UVA account details ===\n");
  const r8 = await client.Runtime.evaluate({
    expression: `
      (() => {
        const ga = window.GoogleAccount;
        const list = ga?.accountList;
        if (!list) return { error: "No accountList" };

        const uva = list.find(a => (a?.user?.emailAddress || '').includes('virginia.edu'));
        if (!uva) return { error: "UVA not found" };

        return {
          email: uva?.user?.emailAddress,
          provider: uva?.user?._provider,
          hasListRouter: !!uva?.listRouter,
          listRouterSplits: uva?.listRouter?._splits?.map(s => ({
            id: s.id, name: s.matcher?.name, isDisabled: s.isDisabled,
          })),
          hasSettings: !!uva?.listRouter?._settings,
          settingsRestrictiveImportant: uva?.listRouter?._settings?._cache?.restrictiveImportant,
          settingsSplitInboxCount: uva?.listRouter?._settings?._cache?.splitInboxes?.length,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(r8.result?.value, null, 2));

  await client.close();
}

main().catch(console.error);
