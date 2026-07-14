/**
 * Regression tests for the CDP-free `sync --check` path.
 *
 * Bug: `superhuman sync --check` is documented (and used by the morning-briefing
 * freshness gate) as a pure on-disk cache-staleness report needing no CDP. But
 * `cmdSync` enumerated accounts only via `listSyncableAccounts()` (a live
 * background_page read over CDP) and hard-exited with "No linked accounts found"
 * when the app wasn't running with the debug port — before ever reaching the
 * `--check` branch. So the report was impossible exactly when it mattered most
 * (app closed). Compounding it, the on-disk enumerator `listLocalAccounts()`
 * scanned browser roots only, returning [] on a desktop-app install.
 *
 * These are source-level guarantees (the enumerators read real homedir OPFS
 * roots at call time, so a functional test would need un-injectable filesystem
 * fixtures — matching the repo convention in attachment-download.test.ts of
 * asserting the wiring at the source level).
 */
import { test, expect, describe } from "bun:test";

const cliSrc = await Bun.file(new URL("../cli.ts", import.meta.url)).text();
const sqliteSrc = await Bun.file(new URL("../sqlite-search.ts", import.meta.url)).text();

describe("sync --check offline enumeration", () => {
  test("cmdSync falls back to on-disk enumeration when the app is unreachable", () => {
    // Locate the sync command body.
    const start = cliSrc.indexOf("async function cmdSync(");
    expect(start).toBeGreaterThan(-1);
    const body = cliSrc.slice(start, start + 2500);

    // Live CDP enumeration is still tried first…
    expect(body).toContain("listSyncableAccounts(options.port)");
    // …and falls back to the pure on-disk scan when it returns nothing.
    expect(body).toContain("listLocalAccounts()");
  });

  test("cmdSync no longer hard-exits before the --check branch", () => {
    const start = cliSrc.indexOf("async function cmdSync(");
    const checkIdx = cliSrc.indexOf("if (options.check)", start);
    const exitIdx = cliSrc.indexOf("process.exit(1)", start);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(-1);
    // The remaining hard-exit must only fire AFTER the disk fallback has also
    // come up empty — its guard mentions the on-disk cache, and the --check
    // branch is still reachable (exit is guarded by targets.length === 0).
    const exitLine = cliSrc.slice(exitIdx - 320, exitIdx);
    expect(exitLine).toContain("targets.length === 0");
    expect(cliSrc.slice(start, exitIdx)).toContain("cached account blobs found on disk");
  });

  test("each --check report entry carries a source (app|disk) field", () => {
    const start = cliSrc.indexOf("if (options.check)", cliSrc.indexOf("async function cmdSync("));
    const branch = cliSrc.slice(start, start + 700);
    expect(branch).toContain('source: enumeratedFromDisk ? "disk" : "app"');
  });
});

describe("listLocalAccounts desktop-over-browser precedence", () => {
  test("scans DESKTOP_ROOTS first, not browser roots only", () => {
    const start = sqliteSrc.indexOf("export function listLocalAccounts(");
    expect(start).toBeGreaterThan(-1);
    const body = sqliteSrc.slice(start, start + 700);
    // Must consult the authoritative desktop data dir…
    expect(body).toContain("DESKTOP_ROOTS.filter");
    // …and consult browser roots only as the no-desktop fallback (same pattern
    // as findOPFSBlob), never browser-roots-only as before.
    expect(body).toContain("desktopRoots.length > 0 ? desktopRoots : BROWSER_ROOTS");
  });
});
