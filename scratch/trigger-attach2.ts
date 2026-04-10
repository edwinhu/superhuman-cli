#!/usr/bin/env bun
/**
 * Investigate Superhuman's attachment mechanism and try file chooser interception.
 */

import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";

async function main() {
  const targets = await CDP.List({ port: 9400 });
  const mainPage = targets.find(
    (t: any) => t.url.includes("mail.superhuman.com") && t.type === "page"
  );

  if (!mainPage) {
    console.error("Superhuman main page not found");
    process.exit(1);
  }

  const client = await CDP({ port: 9400, target: mainPage.id });
  const { Runtime, DOM, Input, Page } = client;

  await Runtime.enable();
  await DOM.enable();
  await Page.enable();

  // Step 1: Explore the Superhuman window object
  const explore = await Runtime.evaluate({
    expression: `
      const sh = window.Superhuman;
      const keys = sh ? Object.keys(sh) : [];
      const desc = {};
      for (const k of keys.slice(0, 50)) {
        desc[k] = typeof sh[k];
      }
      JSON.stringify({ type: typeof sh, keys: keys.length, sample: desc }, null, 2);
    `,
  });
  console.log("Superhuman object:", explore.result.value);

  // Step 2: Check for compose-related elements more broadly
  const composeCheck = await Runtime.evaluate({
    expression: `
      // Look for the compose area
      const compose = document.querySelector('.ThreadListView-compose, [class*="Compose"], [class*="compose"]');
      if (!compose) return 'No compose area';

      // Get all interactive elements inside compose
      const elements = compose.querySelectorAll('button, [role="button"], [data-test-id], svg, [class*="icon"], [class*="toolbar"], [class*="action"]');
      const results = [];
      elements.forEach((el, i) => {
        if (i > 30) return;
        const rect = el.getBoundingClientRect();
        results.push({
          tag: el.tagName,
          class: (el.className?.baseVal || el.className || '').toString().substring(0, 80),
          text: el.textContent?.trim().substring(0, 30),
          ariaLabel: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          testId: el.getAttribute('data-test-id'),
          role: el.getAttribute('role'),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      });
      JSON.stringify(results, null, 2);
    `,
  });
  console.log("\nCompose elements:", composeCheck.result.value);

  // Step 3: Enable file chooser interception
  console.log("\nEnabling file chooser interception...");
  await Page.setInterceptFileChooserDialog({ enabled: true });

  // Listen for file chooser
  let fileChooserOpened = false;
  Page.fileChooserOpened(async (params: any) => {
    console.log("FILE CHOOSER OPENED!", JSON.stringify(params));
    fileChooserOpened = true;

    // Read the test file and provide it
    try {
      const content = readFileSync("/tmp/test-attachment.txt");
      // Accept the file chooser with our test file
      await DOM.setFileInputFiles({
        files: ["/tmp/test-attachment.txt"],
        backendNodeId: params.backendNodeId,
      });
      console.log("File accepted via file chooser!");
    } catch (e: any) {
      console.log("File chooser accept error:", e.message);
    }
  });

  // Step 4: Open compose
  console.log("Opening compose (Cmd+N)...");
  await Input.dispatchKeyEvent({
    type: "rawKeyDown",
    key: "n",
    code: "KeyN",
    modifiers: 4,
    windowsVirtualKeyCode: 78,
  });
  await Input.dispatchKeyEvent({
    type: "keyUp",
    key: "n",
    code: "KeyN",
    modifiers: 4,
    windowsVirtualKeyCode: 78,
  });

  await new Promise(resolve => setTimeout(resolve, 1500));

  // Step 5: Look for the attach button/icon in the toolbar
  const toolbar = await Runtime.evaluate({
    expression: `
      // Look for toolbar/action bar in compose
      const allElements = document.querySelectorAll('[class*="Toolbar"], [class*="toolbar"], [class*="ActionBar"], [class*="action-bar"], [class*="ComposeActions"], [class*="compose-action"]');
      const results = [];
      allElements.forEach((el) => {
        const children = el.querySelectorAll('*');
        children.forEach((child) => {
          const rect = child.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            results.push({
              tag: child.tagName,
              class: (child.className?.baseVal || child.className || '').toString().substring(0, 60),
              ariaLabel: child.getAttribute('aria-label'),
              title: child.getAttribute('title'),
              testId: child.getAttribute('data-test-id'),
              x: Math.round(rect.x),
              y: Math.round(rect.y),
            });
          }
        });
      });
      JSON.stringify(results.slice(0, 30), null, 2);
    `,
  });
  console.log("\nToolbar elements:", toolbar.result.value);

  // Step 6: Try just the keyboard shortcut for attach
  // Superhuman might use just 'a' when in compose mode for attach
  // Or maybe Shift+Cmd+A
  console.log("\nLooking for 'Attach' in Superhuman shortcuts...");
  const shortcuts = await Runtime.evaluate({
    expression: `
      // Check for React internal state or Superhuman app state
      const appRoot = document.querySelector('#root, #app, [data-reactroot]');
      const fiberKey = appRoot && Object.keys(appRoot).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));

      // Also search for any element with attach-related attributes
      const allEls = document.querySelectorAll('*');
      const attachEls = [];
      allEls.forEach(el => {
        const attrs = Array.from(el.attributes || []);
        for (const attr of attrs) {
          if (attr.value && attr.value.toLowerCase().includes('attach')) {
            attachEls.push({
              tag: el.tagName,
              attr: attr.name,
              value: attr.value.substring(0, 50),
              class: (el.className?.baseVal || el.className || '').toString().substring(0, 50),
            });
          }
        }
      });

      JSON.stringify({
        hasFiber: !!fiberKey,
        fiberKey: fiberKey || null,
        attachElements: attachEls.slice(0, 10),
      }, null, 2);
    `,
  });
  console.log("Shortcuts/attach search:", shortcuts.result.value);

  // Step 7: Try drag-and-drop approach
  console.log("\nTrying drag-and-drop approach...");

  // Get compose area coordinates
  const composeRect = await Runtime.evaluate({
    expression: `
      const compose = document.querySelector('.ThreadListView-compose, [class*="Compose"]');
      if (!compose) return null;
      const rect = compose.getBoundingClientRect();
      JSON.stringify({ x: rect.x + rect.width/2, y: rect.y + rect.height/2, w: rect.width, h: rect.height });
    `,
  });
  console.log("Compose area:", composeRect.result.value);

  if (composeRect.result.value) {
    const rect = JSON.parse(composeRect.result.value);

    // Simulate drop event with file
    const dropResult = await Runtime.evaluate({
      expression: `
        (async () => {
          const compose = document.querySelector('.ThreadListView-compose, [class*="Compose"]');
          if (!compose) return 'No compose element';

          // Find the contenteditable or textarea inside
          const editor = compose.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
          const target = editor || compose;

          // Create a File object
          const fileContent = new Blob(['test attachment content\\n'], { type: 'text/plain' });
          const file = new File([fileContent], 'test-attachment.txt', { type: 'text/plain' });

          // Create DataTransfer
          const dt = new DataTransfer();
          dt.items.add(file);

          // Fire drag events
          const dragEnter = new DragEvent('dragenter', { dataTransfer: dt, bubbles: true });
          const dragOver = new DragEvent('dragover', { dataTransfer: dt, bubbles: true });
          const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true });

          target.dispatchEvent(dragEnter);
          target.dispatchEvent(dragOver);
          target.dispatchEvent(drop);

          return 'Drop events fired on: ' + target.tagName + ' class=' + (target.className || '').substring(0, 50);
        })()
      `,
      awaitPromise: true,
    });
    console.log("Drop result:", dropResult.result.value);
  }

  // Wait for network activity
  console.log("\nWaiting 5s for network activity...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Check monitor output
  console.log("File chooser opened:", fileChooserOpened);

  // Escape compose
  await Input.dispatchKeyEvent({
    type: "rawKeyDown",
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
