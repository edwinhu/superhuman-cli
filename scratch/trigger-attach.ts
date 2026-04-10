#!/usr/bin/env bun
/**
 * Trigger file attachment in Superhuman via CDP.
 *
 * Steps:
 * 1. Open compose with Cmd+N
 * 2. Find the file input element
 * 3. Upload a test file
 * 4. Wait for the attachment API call to be captured by monitor script
 */

import CDP from "chrome-remote-interface";

async function main() {
  const targets = await CDP.List({ port: 9400 });
  const mainPage = targets.find(
    (t: any) => t.url.includes("mail.superhuman.com") && t.type === "page"
  );

  if (!mainPage) {
    console.error("Superhuman main page not found");
    process.exit(1);
  }

  console.log("Connecting to:", mainPage.url);
  const client = await CDP({ port: 9400, target: mainPage.id });
  const { Runtime, DOM, Input, Page } = client;

  await Runtime.enable();
  await DOM.enable();
  await Page.enable();

  // First, let's see what's on screen - check for existing compose window
  const checkCompose = await Runtime.evaluate({
    expression: `
      // Check if compose is already open
      const composeEl = document.querySelector('[data-test-id="compose"], [class*="compose"], [aria-label*="Compose"], [role="dialog"]');
      composeEl ? 'Compose window found: ' + composeEl.tagName + ' ' + (composeEl.className || '') : 'No compose window';
    `,
  });
  console.log("Compose check:", checkCompose.result.value);

  // Open compose with Cmd+N
  console.log("Opening compose window (Cmd+N)...");
  await Input.dispatchKeyEvent({
    type: "keyDown",
    key: "n",
    code: "KeyN",
    modifiers: 4, // Meta/Cmd
    windowsVirtualKeyCode: 78,
  });
  await Input.dispatchKeyEvent({
    type: "keyUp",
    key: "n",
    code: "KeyN",
    modifiers: 4,
    windowsVirtualKeyCode: 78,
  });

  // Wait for compose to open
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Look for file input elements
  const findInputs = await Runtime.evaluate({
    expression: `
      // Find all file inputs (visible and hidden)
      const inputs = document.querySelectorAll('input[type="file"]');
      const results = [];
      inputs.forEach((inp, i) => {
        results.push({
          index: i,
          accept: inp.accept,
          multiple: inp.multiple,
          id: inp.id,
          name: inp.name,
          className: inp.className,
          display: getComputedStyle(inp).display,
          parentTag: inp.parentElement?.tagName,
        });
      });

      // Also check for attachment buttons
      const attachBtns = document.querySelectorAll('[data-test-id*="attach"], [aria-label*="ttach"], [title*="ttach"], button[class*="attach"]');
      const btnResults = [];
      attachBtns.forEach((btn, i) => {
        btnResults.push({
          index: i,
          tagName: btn.tagName,
          text: btn.textContent?.trim(),
          ariaLabel: btn.getAttribute('aria-label'),
          title: btn.getAttribute('title'),
          className: btn.className,
        });
      });

      JSON.stringify({ fileInputs: results, attachButtons: btnResults }, null, 2);
    `,
  });
  console.log("File inputs and attach buttons:", findInputs.result.value);

  // Try pressing Cmd+Shift+A (Superhuman shortcut for attach)
  console.log("\nTrying Cmd+Shift+A (attach shortcut)...");
  await Input.dispatchKeyEvent({
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 4 | 8, // Meta + Shift
    windowsVirtualKeyCode: 65,
  });
  await Input.dispatchKeyEvent({
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 4 | 8,
    windowsVirtualKeyCode: 65,
  });

  await new Promise(resolve => setTimeout(resolve, 1000));

  // Check again for file inputs after shortcut
  const findInputs2 = await Runtime.evaluate({
    expression: `
      const inputs = document.querySelectorAll('input[type="file"]');
      const results = [];
      inputs.forEach((inp, i) => {
        results.push({
          index: i,
          accept: inp.accept,
          id: inp.id,
          className: inp.className,
        });
      });
      JSON.stringify(results, null, 2);
    `,
  });
  console.log("File inputs after shortcut:", findInputs2.result.value);

  // If there's a file input, upload to it via CDP
  const { root } = await DOM.getDocument();
  const fileInputNodes = await DOM.querySelectorAll({
    nodeId: root.nodeId,
    selector: 'input[type="file"]',
  });

  if (fileInputNodes.nodeIds.length > 0) {
    console.log(`\nFound ${fileInputNodes.nodeIds.length} file input(s). Uploading test file...`);

    for (const nodeId of fileInputNodes.nodeIds) {
      try {
        await DOM.setFileInputFiles({
          nodeId,
          files: ["/tmp/test-attachment.txt"],
        });
        console.log("File uploaded to input node:", nodeId);
      } catch (e: any) {
        console.log("Failed to upload to node", nodeId, ":", e.message);
      }
    }
  } else {
    console.log("\nNo file inputs found. Let's try a different approach...");

    // Check for React fiber or Superhuman-specific APIs
    const checkAPI = await Runtime.evaluate({
      expression: `
        // Check for Superhuman internal APIs
        const keys = Object.keys(window).filter(k =>
          k.toLowerCase().includes('superhuman') ||
          k.toLowerCase().includes('attachment') ||
          k.toLowerCase().includes('draft') ||
          k.toLowerCase().includes('compose')
        );
        JSON.stringify(keys);
      `,
    });
    console.log("Window keys:", checkAPI.result.value);
  }

  // Wait a few seconds for any network calls to fire
  console.log("\nWaiting 5s for network activity...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Close compose with Escape
  console.log("Closing compose (Escape)...");
  await Input.dispatchKeyEvent({
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await Input.dispatchKeyEvent({
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });

  await client.close();
  console.log("Done.");
}

main().catch(console.error);
