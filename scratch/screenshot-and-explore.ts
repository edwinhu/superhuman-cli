#!/usr/bin/env bun
/**
 * Take a screenshot and explore the Superhuman DOM for compose/attach elements
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
  const { Runtime, Page } = client;

  await Runtime.enable();
  await Page.enable();

  // Take screenshot
  const screenshot = await Page.captureScreenshot({ format: "png" });
  const fs = await import("fs");
  fs.writeFileSync("/tmp/superhuman-screenshot.png", Buffer.from(screenshot.data, "base64"));
  console.log("Screenshot saved to /tmp/superhuman-screenshot.png");

  // Search the ENTIRE DOM for anything attachment-related
  const domSearch = await Runtime.evaluate({
    expression: `
      const html = document.documentElement.innerHTML;

      // Search for attachment-related class names
      const classMatches = [...html.matchAll(/class="([^"]*(?:attach|upload|file|paperclip|clip)[^"]*)"/gi)];
      const uniqueClasses = [...new Set(classMatches.map(m => m[1]))];

      // Search for data attributes
      const dataMatches = [...html.matchAll(/data-[a-z-]+="([^"]*(?:attach|upload|file)[^"]*)"/gi)];

      // Check for input[type=file] in shadow DOMs
      const allCustomElements = document.querySelectorAll('*');
      const shadowInputs = [];
      allCustomElements.forEach(el => {
        if (el.shadowRoot) {
          const inputs = el.shadowRoot.querySelectorAll('input[type="file"]');
          if (inputs.length > 0) {
            shadowInputs.push({ tag: el.tagName, inputCount: inputs.length });
          }
        }
      });

      // Check for the compose area specifically
      const compose = document.querySelector('.ThreadListView-compose');
      let composeInfo = null;
      if (compose) {
        const innerHTML = compose.innerHTML;
        composeInfo = {
          hasInputFile: innerHTML.includes('type="file"'),
          hasSvg: compose.querySelectorAll('svg').length,
          hasButtons: compose.querySelectorAll('button, [role="button"]').length,
          classList: compose.className,
          childClasses: [...compose.querySelectorAll('[class]')].map(e => e.className).filter(c => typeof c === 'string').slice(0, 20),
        };
      }

      JSON.stringify({
        attachClasses: uniqueClasses.slice(0, 15),
        dataAttrs: dataMatches.map(m => m[0]).slice(0, 10),
        shadowInputs,
        composeInfo,
      }, null, 2);
    `,
  });
  console.log("\nDOM search results:", domSearch.result.value);

  // Look specifically at compose toolbar / bottom bar
  const composeBar = await Runtime.evaluate({
    expression: `
      const compose = document.querySelector('.ThreadListView-compose');
      if (!compose) return 'No compose area found';

      // Get ALL child elements and their classes
      const allChildren = compose.querySelectorAll('*');
      const elements = [];
      allChildren.forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const cls = (el.className?.baseVal || el.className || '').toString();
        if (cls.length > 0) {
          elements.push({
            tag: el.tagName,
            cls: cls.substring(0, 80),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          });
        }
      });

      // Sort by y position (bottom elements likely toolbar)
      elements.sort((a, b) => b.y - a.y);

      JSON.stringify(elements.slice(0, 30), null, 2);
    `,
  });
  console.log("\nCompose children (sorted by y-pos, bottom first):", composeBar.result.value);

  await client.close();
}

main().catch(console.error);
