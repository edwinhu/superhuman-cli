/**
 * Canary test: ensures no provider-specific API URLs, OAuth constants,
 * or direct provider fetch helpers remain in the source after refactoring.
 *
 * Expected to FAIL before the refactoring and PASS after.
 */
import { test, expect, describe } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..");

/** Recursively collect all .ts files, excluding test/scratch/investigation dirs. */
async function collectTsFiles(dir: string): Promise<string[]> {
  const EXCLUDED_DIRS = new Set(["__tests__", "api-investigation", "scratch"]);
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectTsFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Read all source files once and return a map of path -> content. */
async function loadSources(): Promise<Map<string, string>> {
  const files = await collectTsFiles(SRC_DIR);
  const map = new Map<string, string>();
  await Promise.all(
    files.map(async (f) => {
      const text = await Bun.file(f).text();
      map.set(f, text);
    }),
  );
  return map;
}

/** Find files whose content matches a pattern, returning relative paths. */
function filesMatching(
  sources: Map<string, string>,
  pattern: RegExp,
): string[] {
  const hits: string[] = [];
  for (const [path, content] of sources) {
    if (pattern.test(content)) {
      hits.push(path.replace(SRC_DIR + "/", ""));
    }
  }
  return hits.sort();
}

describe("no provider APIs remain in src/", () => {
  let sources: Map<string, string>;

  // Load all files once before the suite runs.
  test("load source files", async () => {
    sources = await loadSources();
    expect(sources.size).toBeGreaterThan(0);
  });

  test("no Gmail/Drive googleapis.com URLs (calendar + Firebase JWT allowed)", () => {
    // Allow: securetoken.googleapis.com (Firebase JWT issuer check)
    // Allow: googleapis.com/calendar (Google Calendar API)
    // Allow: CDP fetch patterns like "*googleapis.com*" (token extraction)
    // Allow: draft-api.ts still contains legacy sendViaGmailApi and fetchGmailMessageHtml
    //   (fetchGmailMessageHtml is used for forward body fetching)
    // Allow: attachments.ts uses gmail.googleapis.com for attachment download
    //   (confirmed exception: no Superhuman backend endpoint for downloading received attachments)
    // Disallow: gmail.googleapis.com, people.googleapis.com, etc. everywhere else
    const allowlist = new Set(["draft-api.ts", "attachments.ts"]);
    const hits: string[] = [];
    for (const [path, content] of sources) {
      const rel = path.replace(SRC_DIR + "/", "");
      if (allowlist.has(rel)) continue;
      const lines = content.split("\n");
      for (const line of lines) {
        if (/googleapis\.com/.test(line) &&
            !/securetoken\.googleapis\.com/.test(line) &&
            !/googleapis\.com\/calendar/.test(line) &&
            !/"\*googleapis\.com\*"/.test(line)) {
          hits.push(rel);
          break;
        }
      }
    }
    expect(hits.sort()).toEqual([]);
  });

  test("no graph.microsoft.com URLs (CDP fetch pattern allowed)", () => {
    // Allow: CDP fetch patterns like "*graph.microsoft.com*" (token extraction)
    // Allow: calendar.ts uses graph.microsoft.com URLs via Superhuman's microsoftCalendar.proxy backend
    // Allow: attachments.ts uses graph.microsoft.com for attachment download
    //   (confirmed exception: no Superhuman backend endpoint for downloading received attachments)
    // Disallow: actual direct graph.microsoft.com API calls
    // Allow: read.ts uses graph.microsoft.com for MS Graph read fallback
    //   (confirmed exception: userdata.getThreads returns 400 for all MS/Exchange accounts)
    const allowlist = new Set(["calendar.ts", "attachments.ts", "read.ts"]);
    const hits: string[] = [];
    for (const [path, content] of sources) {
      const rel = path.replace(SRC_DIR + "/", "");
      if (allowlist.has(rel)) continue;
      const lines = content.split("\n");
      for (const line of lines) {
        if (/graph\.microsoft\.com/.test(line) &&
            !/"\*graph\.microsoft\.com\*"/.test(line)) {
          hits.push(rel);
          break;
        }
      }
    }
    expect(hits.sort()).toEqual([]);
  });

  test("no GOOGLE_OAUTH_CLIENT_ID constant", () => {
    const hits = filesMatching(sources, /GOOGLE_OAUTH_CLIENT_ID/);
    expect(hits).toEqual([]);
  });

  test("no MICROSOFT_OAUTH_CLIENT_ID constant", () => {
    const hits = filesMatching(sources, /MICROSOFT_OAUTH_CLIENT_ID/);
    expect(hits).toEqual([]);
  });

  test("no gmailFetch references (excluding import type)", () => {
    const hits: string[] = [];
    for (const [path, content] of sources) {
      // Check each line individually so we can skip `import type` lines
      const lines = content.split("\n");
      for (const line of lines) {
        if (/gmailFetch/.test(line) && !/^\s*import\s+type\b/.test(line)) {
          hits.push(path.replace(SRC_DIR + "/", ""));
          break;
        }
      }
    }
    expect(hits.sort()).toEqual([]);
  });

  test("no msgraphFetch references (excluding import type)", () => {
    const hits: string[] = [];
    for (const [path, content] of sources) {
      const lines = content.split("\n");
      for (const line of lines) {
        if (/msgraphFetch/.test(line) && !/^\s*import\s+type\b/.test(line)) {
          hits.push(path.replace(SRC_DIR + "/", ""));
          break;
        }
      }
    }
    expect(hits.sort()).toEqual([]);
  });
});
