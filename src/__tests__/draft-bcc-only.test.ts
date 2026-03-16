// src/__tests__/draft-bcc-only.test.ts
// Regression test: draft create should accept --bcc without --to
import { test, expect, describe } from "bun:test";

describe("draft create with --bcc only (no --to)", () => {
  test("should NOT error with 'At least one recipient is required' when --bcc is provided", async () => {
    const proc = Bun.spawn(
      [
        process.execPath, "run", "src/cli.ts",
        "draft", "create",
        "--bcc=student@example.com",
        "--subject=Class Announcement",
        "--body=Hello class",
        "--account=test@example.com",
      ],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = stdout + stderr;

    // The command may fail for other reasons (no valid account/token),
    // but it should NOT fail with the recipient validation error.
    expect(output).not.toContain("At least one recipient is required");
  });

  test("should NOT error with 'At least one recipient is required' when --cc is provided", async () => {
    const proc = Bun.spawn(
      [
        process.execPath, "run", "src/cli.ts",
        "draft", "create",
        "--cc=colleague@example.com",
        "--subject=FYI",
        "--body=See attached",
        "--account=test@example.com",
      ],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = stdout + stderr;

    expect(output).not.toContain("At least one recipient is required");
  });

  test("should still error when no recipients at all are provided", async () => {
    const proc = Bun.spawn(
      [
        process.execPath, "run", "src/cli.ts",
        "draft", "create",
        "--subject=No Recipients",
        "--body=This should fail",
        "--account=test@example.com",
      ],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = stdout + stderr;

    expect(output).toContain("At least one recipient is required");
  });
});
