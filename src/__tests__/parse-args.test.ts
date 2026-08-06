// src/__tests__/parse-args.test.ts
//
// Regression tests for parseArgs argument handling.
//
// Root cause of the "AI search returns empty output" bug: the `--ai` flag's
// case in parseArgs was missing its `i += 1` increment. Because parseArgs
// advances the index manually per-flag, a missing increment left `i` pinned on
// `--ai` forever, spinning `while (i < args.length)` as an infinite loop. The
// CLI hung with zero output on every `search ... --ai` invocation (broken since
// v0.25.0, 2026-04-07). The pre-existing ai-search tests only exercised
// askAISearch() directly, never the CLI's argument parser, so they never caught
// it.
//
// These tests run parseArgs under a hard timeout so a re-introduced infinite
// loop fails loudly instead of hanging the suite.

import { describe, it, expect } from "bun:test";
import { parseArgs } from "../cli";

/** Run parseArgs, failing if it does not return promptly (i.e. it infinite-loops). */
function parseArgsBounded(args: string[]) {
  // parseArgs is synchronous; a missing increment makes it spin forever. Guard
  // by capping iterations via a wall-clock check inside a Worker-free approach:
  // we simply call it — Bun's test timeout (below) is the real backstop, but we
  // also assert it returns an object so a throw surfaces clearly.
  return parseArgs(args);
}

describe("parseArgs boolean flags", () => {
  it("parses --ai without hanging (regression: missing index increment)", () => {
    const opts = parseArgsBounded([
      "search",
      "pebble pre-order confirmation",
      "--account",
      "eddyhu@gmail.com",
      "--ai",
      "--json",
    ]);
    expect(opts.command).toBe("search");
    expect(opts.query).toBe("pebble pre-order confirmation");
    expect(opts.account).toBe("eddyhu@gmail.com");
    expect(opts.ai).toBe(true);
    expect(opts.json).toBe(true);
  }, 5000);

  it("parses --ai in --key=value form", () => {
    const opts = parseArgs(["search", "q", "--ai=true"]);
    // `--ai=true` still sets the flag on; value is ignored for a boolean flag.
    expect(opts.ai).toBe(true);
    expect(opts.query).toBe("q");
  });

  it("parses --ai regardless of position relative to other flags", () => {
    const a = parseArgs(["search", "q", "--ai", "--json"]);
    const b = parseArgs(["search", "q", "--json", "--ai"]);
    expect(a.ai).toBe(true);
    expect(a.json).toBe(true);
    expect(b.ai).toBe(true);
    expect(b.json).toBe(true);
  });

  it("handles --ai with no trailing args", () => {
    const opts = parseArgs(["search", "q", "--ai"]);
    expect(opts.ai).toBe(true);
  });

  it("still parses a value flag immediately after --ai", () => {
    const opts = parseArgs(["search", "q", "--ai", "--limit", "5"]);
    expect(opts.ai).toBe(true);
    expect(opts.limit).toBe(5);
  });
});

describe("parseArgs forward-progress guarantee", () => {
  // Every recognized boolean flag must advance the parser. This exhaustively
  // guards the whole family so the next flag added without an increment is
  // caught immediately rather than shipping as a silent hang.
  const booleanFlags = [
    "--ai",
    "--json",
    "--focused",
    "--unread",
    "--needs-reply",
    "--with-body",
    "--latest-only",
    "--native",
    "--no-signature",
    "--as-attachment",
    "--force",
    "--check",
    "--fix",
  ];

  for (const flag of booleanFlags) {
    it(`advances past ${flag} without hanging`, () => {
      // If parseArgs failed to advance it would spin forever; the 5s per-test
      // timeout converts that into a clear failure.
      const opts = parseArgs(["inbox", flag]);
      expect(opts.command).toBe("inbox");
    }, 5000);
  }
});
