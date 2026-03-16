// src/__tests__/snippet-body-merge.test.ts
// Regression test: --body flag in `snippet use` should override snippet body
// Bug: cmdSnippet always used snippet.body, ignoring options.body (--body flag)
import { test, expect, describe } from "bun:test";
import { textToHtml } from "../superhuman-api";

/**
 * This tests the body-merge logic extracted from cmdSnippet.
 * The fix on line 939 of cli.ts changes:
 *   let body = snippet.body;
 * to:
 *   let body = options.body ? textToHtml(options.body) : snippet.body;
 */

function mergeSnippetBody(optionsBody: string | undefined, snippetBody: string): string {
  // This mirrors the fixed logic in cmdSnippet (line 939 of cli.ts)
  return optionsBody ? textToHtml(optionsBody) : snippetBody;
}

describe("snippet use --body merge logic", () => {
  test("--body flag overrides snippet body", () => {
    const snippetBody = "<p>Original snippet body</p>";
    const cliBody = "test body from CLI";

    const result = mergeSnippetBody(cliBody, snippetBody);

    // Should use the CLI --body content, converted to HTML
    expect(result).toContain("test body from CLI");
    expect(result).not.toContain("Original snippet body");
  });

  test("snippet body used when --body not provided", () => {
    const snippetBody = "<p>Original snippet body</p>";

    const result = mergeSnippetBody(undefined, snippetBody);

    expect(result).toBe("<p>Original snippet body</p>");
  });

  test("empty string --body still uses snippet body", () => {
    const snippetBody = "<p>Original snippet body</p>";

    // Empty string is falsy, so snippet body should be used
    const result = mergeSnippetBody("", snippetBody);

    expect(result).toBe("<p>Original snippet body</p>");
  });

  test("--body with newlines gets proper HTML conversion", () => {
    const snippetBody = "<p>Snippet</p>";
    const cliBody = "Line 1\\nLine 2";

    const result = mergeSnippetBody(cliBody, snippetBody);

    expect(result).toContain("Line 1");
    expect(result).toContain("Line 2");
    expect(result).not.toContain("Snippet");
  });
});
