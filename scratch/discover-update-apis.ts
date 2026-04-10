#!/usr/bin/env bun
/**
 * Discover Superhuman backend API endpoints for:
 * - Archive (mark done)
 * - Star/unstar
 * - Add/remove labels
 * - Mark read/unread
 *
 * Strategy: Connect to the main Superhuman page via CDP,
 * enable Network monitoring, then trigger operations via
 * Runtime.evaluate (calling Superhuman's internal JS APIs).
 */

import CDP from "chrome-remote-interface";

const PORT = 9222;

interface CapturedCall {
  operation: string;
  method: string;
  url: string;
  requestBody?: any;
  responseStatus?: number;
  responseBody?: any;
}

const capturedCalls: CapturedCall[] = [];
let currentOperation = "idle";

async function main() {
  console.log(`Listing CDP targets on port ${PORT}...\n`);
  const targets = await CDP.List({ port: PORT });

  // Find all main Superhuman pages
  const mainPages = targets.filter(
    (t: any) => t.type === "page" && t.url?.includes("mail.superhuman.com")
  );
  const serviceWorker = targets.find(
    (t: any) => t.type === "service_worker"
  );

  console.log(`Found ${mainPages.length} Superhuman page(s)`);
  for (const p of mainPages) {
    console.log(`  - ${p.title} (${p.id})`);
  }

  if (mainPages.length === 0) {
    console.error("No Superhuman pages found!");
    process.exit(1);
  }

  // Connect to the first main page for Runtime evaluation
  const mainPage = mainPages[0];
  console.log(`\nConnecting to: ${mainPage.title}\n`);

  const mainClient = await CDP({ port: PORT, target: mainPage.id });
  const { Network: MainNetwork, Runtime, Input } = mainClient;

  // Also connect to service worker for network monitoring
  const clients: CDP.Client[] = [mainClient];

  if (serviceWorker) {
    console.log(`Also connecting to service worker for network monitoring...\n`);
    try {
      const swClient = await CDP({ port: PORT, target: serviceWorker.id });
      clients.push(swClient);
      await setupNetworkMonitoring(swClient, "service_worker");
    } catch (e: any) {
      console.log(`  Could not connect to service worker: ${e.message}`);
    }
  }

  // Enable network monitoring on main page too
  await setupNetworkMonitoring(mainClient, "main_page");

  // Give a moment for setup
  await sleep(1000);

  // Now trigger each operation
  console.log("\n" + "=".repeat(80));
  console.log("TRIGGERING OPERATIONS");
  console.log("=".repeat(80));

  // 1. ARCHIVE
  await triggerOperation("ARCHIVE", async () => {
    const result = await Runtime.evaluate({
      expression: `
        (async () => {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const threadList = window.ViewState?.threadListState?._list?._sortedList?.sorted;
          if (!threadList || threadList.length === 0) return { error: "No threads" };

          const threadRef = threadList[0];
          const thread = ga?.threads?.identityMap?.get?.(threadRef.id);
          if (!thread?._threadModel) return { error: "Thread not found" };

          const model = thread._threadModel;
          const threadId = model.id;
          const isMicrosoft = di?.get?.('isMicrosoft');

          if (isMicrosoft) {
            const msgraph = di?.get?.('msgraph');
            const folders = await msgraph.getAllFolders();
            const archiveFolder = folders?.find(f => f.displayName?.toLowerCase() === 'archive');
            const messageIds = model.messageIds;
            await msgraph.moveMessages(messageIds.map(id => ({ messageId: id, destinationFolderId: archiveFolder.id })));
          } else {
            const gmail = di?.get?.('gmail');
            await gmail.changeLabelsPerThread(threadId, [], ['INBOX']);
          }

          return { success: true, threadId, isMicrosoft: !!isMicrosoft };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("  Result:", JSON.stringify(result.result?.value));
  });

  await sleep(3000);

  // 2. STAR
  await triggerOperation("STAR", async () => {
    const result = await Runtime.evaluate({
      expression: `
        (async () => {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const threadList = window.ViewState?.threadListState?._list?._sortedList?.sorted;
          if (!threadList || threadList.length === 0) return { error: "No threads" };

          const threadRef = threadList[0];
          const thread = ga?.threads?.identityMap?.get?.(threadRef.id);
          if (!thread?._threadModel) return { error: "Thread not found" };

          const model = thread._threadModel;
          const threadId = model.id;
          const isMicrosoft = di?.get?.('isMicrosoft');

          if (isMicrosoft) {
            const msgraph = di?.get?.('msgraph');
            const messageIds = model.messageIds;
            await msgraph.updateMessages(messageIds, { flag: { flagStatus: "flagged" } }, { action: "flag" });
          } else {
            const gmail = di?.get?.('gmail');
            await gmail.changeLabelsPerThread(threadId, ["STARRED"], []);
          }

          return { success: true, threadId, isMicrosoft: !!isMicrosoft };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("  Result:", JSON.stringify(result.result?.value));
  });

  await sleep(3000);

  // 3. UNSTAR
  await triggerOperation("UNSTAR", async () => {
    const result = await Runtime.evaluate({
      expression: `
        (async () => {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const threadList = window.ViewState?.threadListState?._list?._sortedList?.sorted;
          if (!threadList || threadList.length === 0) return { error: "No threads" };

          const threadRef = threadList[0];
          const thread = ga?.threads?.identityMap?.get?.(threadRef.id);
          if (!thread?._threadModel) return { error: "Thread not found" };

          const model = thread._threadModel;
          const threadId = model.id;
          const isMicrosoft = di?.get?.('isMicrosoft');

          if (isMicrosoft) {
            const msgraph = di?.get?.('msgraph');
            const messageIds = model.messageIds;
            await msgraph.updateMessages(messageIds, { flag: { flagStatus: "notFlagged" } }, { action: "unflag" });
          } else {
            const gmail = di?.get?.('gmail');
            await gmail.changeLabelsPerThread(threadId, [], ["STARRED"]);
          }

          return { success: true, threadId, isMicrosoft: !!isMicrosoft };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("  Result:", JSON.stringify(result.result?.value));
  });

  await sleep(3000);

  // 4. MARK UNREAD
  await triggerOperation("MARK_UNREAD", async () => {
    const result = await Runtime.evaluate({
      expression: `
        (async () => {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const threadList = window.ViewState?.threadListState?._list?._sortedList?.sorted;
          if (!threadList || threadList.length === 0) return { error: "No threads" };

          const threadRef = threadList[0];
          const thread = ga?.threads?.identityMap?.get?.(threadRef.id);
          if (!thread?._threadModel) return { error: "Thread not found" };

          const model = thread._threadModel;
          const threadId = model.id;
          const isMicrosoft = di?.get?.('isMicrosoft');

          if (isMicrosoft) {
            const msgraph = di?.get?.('msgraph');
            const messageIds = model.messageIds;
            await msgraph.updateMessages(messageIds, { isRead: false });
          } else {
            const gmail = di?.get?.('gmail');
            await gmail.changeLabelsPerThread(threadId, ["UNREAD"], []);
          }

          return { success: true, threadId, isMicrosoft: !!isMicrosoft };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("  Result:", JSON.stringify(result.result?.value));
  });

  await sleep(3000);

  // 5. MARK READ
  await triggerOperation("MARK_READ", async () => {
    const result = await Runtime.evaluate({
      expression: `
        (async () => {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const threadList = window.ViewState?.threadListState?._list?._sortedList?.sorted;
          if (!threadList || threadList.length === 0) return { error: "No threads" };

          const threadRef = threadList[0];
          const thread = ga?.threads?.identityMap?.get?.(threadRef.id);
          if (!thread?._threadModel) return { error: "Thread not found" };

          const model = thread._threadModel;
          const threadId = model.id;
          const isMicrosoft = di?.get?.('isMicrosoft');

          if (isMicrosoft) {
            const msgraph = di?.get?.('msgraph');
            const messageIds = model.messageIds;
            await msgraph.updateMessages(messageIds, { isRead: true });
          } else {
            const gmail = di?.get?.('gmail');
            await gmail.changeLabelsPerThread(threadId, [], ["UNREAD"]);
          }

          return { success: true, threadId, isMicrosoft: !!isMicrosoft };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("  Result:", JSON.stringify(result.result?.value));
  });

  await sleep(3000);

  // 6. ADD LABEL
  await triggerOperation("ADD_LABEL", async () => {
    const result = await Runtime.evaluate({
      expression: `
        (async () => {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const threadList = window.ViewState?.threadListState?._list?._sortedList?.sorted;
          if (!threadList || threadList.length === 0) return { error: "No threads" };

          const threadRef = threadList[0];
          const thread = ga?.threads?.identityMap?.get?.(threadRef.id);
          if (!thread?._threadModel) return { error: "Thread not found" };

          const model = thread._threadModel;
          const threadId = model.id;
          const isMicrosoft = di?.get?.('isMicrosoft');

          if (isMicrosoft) {
            return { error: "Label operations not supported for Microsoft via this method" };
          }

          const gmail = di?.get?.('gmail');
          const labels = await gmail.getLabels();
          const userLabel = labels?.find(l => l.type === 'user');
          if (!userLabel) return { error: "No user labels found" };

          await gmail.changeLabelsPerThread(threadId, [userLabel.id], []);
          return { success: true, threadId, labelId: userLabel.id, labelName: userLabel.name };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("  Result:", JSON.stringify(result.result?.value));
  });

  await sleep(3000);

  // 7. REMOVE LABEL
  await triggerOperation("REMOVE_LABEL", async () => {
    const result = await Runtime.evaluate({
      expression: `
        (async () => {
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const threadList = window.ViewState?.threadListState?._list?._sortedList?.sorted;
          if (!threadList || threadList.length === 0) return { error: "No threads" };

          const threadRef = threadList[0];
          const thread = ga?.threads?.identityMap?.get?.(threadRef.id);
          if (!thread?._threadModel) return { error: "Thread not found" };

          const model = thread._threadModel;
          const threadId = model.id;
          const isMicrosoft = di?.get?.('isMicrosoft');

          if (isMicrosoft) {
            return { error: "Label operations not supported for Microsoft via this method" };
          }

          const gmail = di?.get?.('gmail');
          const labels = await gmail.getLabels();
          const userLabel = labels?.find(l => l.type === 'user');
          if (!userLabel) return { error: "No user labels found" };

          await gmail.changeLabelsPerThread(threadId, [], [userLabel.id]);
          return { success: true, threadId, labelId: userLabel.id, labelName: userLabel.name };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("  Result:", JSON.stringify(result.result?.value));
  });

  await sleep(3000);

  // 8. Also check: what does userdata.writeMessage do for these operations?
  // Superhuman also writes local state via userdata.writeMessage
  await triggerOperation("CHECK_USERDATA_WRITE", async () => {
    const result = await Runtime.evaluate({
      expression: `
        (async () => {
          const ga = window.GoogleAccount;
          const backend = ga?.backend;
          if (!backend) return { error: "Backend not found" };

          // List all methods on the backend object
          const methods = [];
          let obj = backend;
          while (obj && obj !== Object.prototype) {
            for (const key of Object.getOwnPropertyNames(obj)) {
              if (typeof obj[key] === 'function' && !key.startsWith('_')) {
                methods.push(key);
              }
            }
            obj = Object.getPrototypeOf(obj);
          }

          // Also check labels service
          const di = ga?.di;
          const labelService = di?.get?.('labels') || di?.get?.('labelService');
          const labelMethods = [];
          if (labelService) {
            let lobj = labelService;
            while (lobj && lobj !== Object.prototype) {
              for (const key of Object.getOwnPropertyNames(lobj)) {
                if (typeof lobj[key] === 'function') {
                  labelMethods.push(key);
                }
              }
              lobj = Object.getPrototypeOf(lobj);
            }
          }

          return {
            backendMethods: [...new Set(methods)].sort(),
            labelServiceAvailable: !!labelService,
            labelMethods: [...new Set(labelMethods)].sort()
          };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("  Backend methods:", JSON.stringify(result.result?.value, null, 2));
  });

  // Print summary
  console.log("\n\n" + "#".repeat(100));
  console.log("SUMMARY OF ALL CAPTURED NETWORK CALLS");
  console.log("#".repeat(100));

  if (capturedCalls.length === 0) {
    console.log("\nNo network calls captured during operations.");
    console.log("This likely means Superhuman uses direct Gmail/MS Graph API calls,");
    console.log("NOT Superhuman backend endpoints for these operations.");
  } else {
    const byOp = new Map<string, CapturedCall[]>();
    for (const call of capturedCalls) {
      const existing = byOp.get(call.operation) || [];
      existing.push(call);
      byOp.set(call.operation, existing);
    }

    for (const [op, calls] of byOp) {
      console.log(`\n--- ${op} ---`);
      for (const call of calls) {
        console.log(`  ${call.method} ${call.url}`);
        if (call.requestBody) {
          const bodyStr = typeof call.requestBody === 'string'
            ? call.requestBody
            : JSON.stringify(call.requestBody);
          console.log(`  Body: ${bodyStr.substring(0, 500)}`);
        }
        if (call.responseStatus) {
          console.log(`  Status: ${call.responseStatus}`);
        }
      }
    }
  }

  console.log(`\nTotal calls: ${capturedCalls.length}`);

  // Cleanup
  for (const client of clients) {
    try { await client.close(); } catch {}
  }

  process.exit(0);
}

async function setupNetworkMonitoring(client: CDP.Client, source: string) {
  const { Network } = client;
  await Network.enable({ maxPostDataSize: 65536 });

  const pending = new Map<string, any>();
  const responses = new Map<string, any>();

  Network.requestWillBeSent((params: any) => {
    const url = params.request.url;
    // Capture Gmail API, MS Graph, and Superhuman backend calls
    if (
      url.includes("googleapis.com/gmail") ||
      url.includes("googleapis.com/batch") ||
      url.includes("graph.microsoft.com") ||
      url.includes("superhuman.com/~backend/v3/userdata") ||
      url.includes("superhuman.com/~backend/v3/labels") ||
      url.includes("superhuman.com/~backend/v3/messages") ||
      url.includes("superhuman.com/~backend/v3/threads")
    ) {
      pending.set(params.requestId, {
        url,
        method: params.request.method,
        postData: params.request.postData,
        source,
      });
    }
  });

  Network.responseReceived(async (params: any) => {
    if (!pending.has(params.requestId)) return;
    responses.set(params.requestId, { status: params.response.status });
    try {
      const body = await Network.getResponseBody({ requestId: params.requestId });
      const existing = responses.get(params.requestId);
      if (existing) existing.body = body.body;
    } catch {}
  });

  Network.loadingFinished((params: any) => {
    const req = pending.get(params.requestId);
    const resp = responses.get(params.requestId);

    if (req) {
      let requestBody: any;
      if (req.postData) {
        try { requestBody = JSON.parse(req.postData); } catch { requestBody = req.postData; }
      }

      let responseBody: any;
      if (resp?.body) {
        try { responseBody = JSON.parse(resp.body); } catch { responseBody = resp.body; }
      }

      const call: CapturedCall = {
        operation: currentOperation,
        method: req.method,
        url: req.url,
        requestBody,
        responseStatus: resp?.status,
        responseBody,
      };
      capturedCalls.push(call);

      console.log(`\n  [${source}/${currentOperation}] ${req.method} ${req.url.substring(0, 120)}`);
      if (requestBody) {
        const s = JSON.stringify(requestBody);
        console.log(`    Body: ${s.substring(0, 300)}`);
      }
      if (resp?.status) console.log(`    Status: ${resp.status}`);
    }

    pending.delete(params.requestId);
    responses.delete(params.requestId);
  });
}

async function triggerOperation(name: string, fn: () => Promise<void>) {
  console.log(`\n--- ${name} ---`);
  currentOperation = name;
  try {
    await fn();
  } catch (e: any) {
    console.log(`  ERROR: ${e.message}`);
  }
  currentOperation = "idle";
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
