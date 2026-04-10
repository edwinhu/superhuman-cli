#!/usr/bin/env bun
/**
 * Open compose in Superhuman by simulating keyboard event via JS,
 * then trigger attachment via drag-and-drop.
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

  const client = await CDP({ port: 9400, target: mainPage.id });
  const { Runtime, DOM, Input, Page } = client;

  await Runtime.enable();
  await DOM.enable();
  await Page.enable();

  // Enable file chooser interception
  await Page.setInterceptFileChooserDialog({ enabled: true });

  Page.fileChooserOpened(async (params: any) => {
    console.log("*** FILE CHOOSER OPENED! ***", JSON.stringify(params));
    try {
      await Page.handleFileChooser({
        action: "accept",
        files: ["/tmp/test-attachment.txt"],
      });
      console.log("File accepted!");
    } catch (e: any) {
      console.log("handleFileChooser error:", e.message);
    }
  });

  // Step 1: Open compose by simulating 'c' keypress (Superhuman shortcut)
  // Superhuman uses 'c' for compose, not Cmd+N
  console.log("Trying 'c' key to open compose...");
  await Input.dispatchKeyEvent({
    type: "keyDown",
    key: "c",
    code: "KeyC",
    text: "c",
    windowsVirtualKeyCode: 67,
    nativeVirtualKeyCode: 67,
  });
  await Input.dispatchKeyEvent({
    type: "keyUp",
    key: "c",
    code: "KeyC",
    windowsVirtualKeyCode: 67,
    nativeVirtualKeyCode: 67,
  });

  await new Promise(resolve => setTimeout(resolve, 2000));

  // Check if compose opened
  const check1 = await Runtime.evaluate({
    expression: `
      // Look for compose dialog/modal
      const composeDialog = document.querySelector('[class*="ComposeView"], [class*="ComposeDialog"], [class*="DraftEditor"], [class*="FullCompose"]');
      const editors = document.querySelectorAll('[contenteditable="true"]');
      const dialogs = document.querySelectorAll('[role="dialog"]');

      JSON.stringify({
        composeDialog: composeDialog ? composeDialog.className.substring(0, 80) : null,
        editableCount: editors.length,
        dialogCount: dialogs.length,
        editableClasses: [...editors].map(e => (e.className || '').substring(0, 60)),
        dialogClasses: [...dialogs].map(e => (e.className || '').substring(0, 60)),
      });
    `,
  });
  console.log("After 'c' key:", check1.result.value);

  // Take screenshot to see what happened
  const screenshot = await Page.captureScreenshot({ format: "png" });
  const fs = await import("fs");
  fs.writeFileSync("/tmp/superhuman-after-c.png", Buffer.from(screenshot.data, "base64"));
  console.log("Screenshot saved to /tmp/superhuman-after-c.png");

  // If compose is open, look for the attach button
  const parsed = JSON.parse(check1.result.value);

  if (parsed.editableCount > 0 || parsed.composeDialog || parsed.dialogCount > 0) {
    console.log("\nCompose appears open! Looking for attach mechanism...");

    // Search for all interactive elements in compose
    const composeElements = await Runtime.evaluate({
      expression: `
        // Get ALL elements in the compose area
        const dialogs = document.querySelectorAll('[role="dialog"]');
        const composeViews = document.querySelectorAll('[class*="ComposeView"], [class*="FullCompose"], [class*="DraftView"]');
        const containers = dialogs.length > 0 ? dialogs : composeViews;

        const results = [];
        containers.forEach(container => {
          const allEls = container.querySelectorAll('*');
          allEls.forEach(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const cls = (el.className?.baseVal || el.className || '').toString();

            // Only log interactive or potentially attachment-related elements
            if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' ||
                el.tagName === 'SVG' || el.tagName === 'svg' ||
                el.getAttribute('role') === 'button' ||
                el.getAttribute('tabindex') ||
                cls.includes('icon') || cls.includes('Icon') ||
                cls.includes('action') || cls.includes('Action') ||
                cls.includes('toolbar') || cls.includes('Toolbar') ||
                cls.includes('attach') || cls.includes('Attach') ||
                cls.includes('button') || cls.includes('Button')) {
              results.push({
                tag: el.tagName,
                cls: cls.substring(0, 80),
                ariaLabel: el.getAttribute('aria-label'),
                title: el.getAttribute('title'),
                role: el.getAttribute('role'),
                tabindex: el.getAttribute('tabindex'),
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
              });
            }
          });
        });

        JSON.stringify(results, null, 2);
      `,
    });
    console.log("Interactive compose elements:", composeElements.result.value);

    // Try Superhuman's attach shortcut: just 'a' key (might work in compose context)
    // Or look for the paperclip icon to click
    // First try drag-and-drop on the editor
    console.log("\nSimulating file drop on editor...");
    const dropResult = await Runtime.evaluate({
      expression: `
        (async () => {
          const editors = document.querySelectorAll('[contenteditable="true"]');
          const editor = editors[editors.length - 1]; // Last one is likely compose
          if (!editor) return 'No editor found';

          // Create file
          const blob = new Blob(['test attachment content'], { type: 'text/plain' });
          const file = new File([blob], 'test-attachment.txt', { type: 'text/plain', lastModified: Date.now() });

          // Build DataTransfer
          const dt = new DataTransfer();
          dt.items.add(file);

          // Dispatch events in sequence
          const events = ['dragenter', 'dragover', 'drop'];
          for (const eventType of events) {
            const event = new DragEvent(eventType, {
              dataTransfer: dt,
              bubbles: true,
              cancelable: true,
            });
            editor.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 100));
          }

          return 'Events dispatched to: ' + editor.tagName + '.' + (editor.className || '').substring(0, 50);
        })()
      `,
      awaitPromise: true,
    });
    console.log("Drop result:", dropResult.result.value);

    // Wait for network
    console.log("\nWaiting 5s for network activity...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Take another screenshot
    const screenshot2 = await Page.captureScreenshot({ format: "png" });
    fs.writeFileSync("/tmp/superhuman-after-drop.png", Buffer.from(screenshot2.data, "base64"));
    console.log("Screenshot saved to /tmp/superhuman-after-drop.png");
  } else {
    console.log("\nCompose didn't open with 'c'. Let me try clicking the compose button...");

    // Try clicking the compose area
    const composeBtn = await Runtime.evaluate({
      expression: `
        const btn = document.querySelector('.ThreadListView-compose');
        if (btn) {
          const rect = btn.getBoundingClientRect();
          return JSON.stringify({ x: rect.x + rect.width/2, y: rect.y + rect.height/2 });
        }
        return null;
      `,
    });

    if (composeBtn.result.value) {
      const coords = JSON.parse(composeBtn.result.value);
      console.log("Clicking compose button at:", coords);
      await Input.dispatchMouseEvent({
        type: "mousePressed",
        x: coords.x,
        y: coords.y,
        button: "left",
        clickCount: 1,
      });
      await Input.dispatchMouseEvent({
        type: "mouseReleased",
        x: coords.x,
        y: coords.y,
        button: "left",
        clickCount: 1,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));
      const screenshot3 = await Page.captureScreenshot({ format: "png" });
      fs.writeFileSync("/tmp/superhuman-after-click.png", Buffer.from(screenshot3.data, "base64"));
      console.log("Screenshot saved to /tmp/superhuman-after-click.png");
    }
  }

  // Close with Escape
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
