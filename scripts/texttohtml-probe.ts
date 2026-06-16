#!/usr/bin/env bun
/**
 * Probe for the production textToHtml / linkifyUrls helpers in
 * src/superhuman-api.ts. Reads plain text on stdin and writes the resulting
 * HTML to stdout, so the pytest suite can assert on the real code path that
 * builds reply/draft bodies.
 *
 * Usage:
 *   echo "https://x.com" | bun scripts/texttohtml-probe.ts
 *   echo "..."          | bun scripts/texttohtml-probe.ts --linkify   # linkifyUrls only
 */
import { textToHtml, linkifyUrls } from "../src/superhuman-api";

const mode = process.argv.includes("--linkify") ? "linkify" : "texttohtml";

const input = await Bun.stdin.text();
// Strip the single trailing newline the shell/`echo` adds; preserve internal ones.
const text = input.endsWith("\n") ? input.slice(0, -1) : input;

const out = mode === "linkify" ? linkifyUrls(text) : textToHtml(text);
process.stdout.write(out);
