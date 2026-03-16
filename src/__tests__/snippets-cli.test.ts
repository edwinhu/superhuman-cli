// src/__tests__/snippets-cli.test.ts
// Tests for snippets CLI command dispatch (singular and plural forms)
import { test, expect, describe } from "bun:test";

describe("snippets CLI command", () => {
  test("snippet list is recognized (singular)", async () => {
    const proc = Bun.spawn(
      [process.execPath, "run", "src/cli.ts", "snippet", "list", "--account=test@example.com"],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const output = stdout + stderr;

    // Should NOT fail with "Unexpected argument: list"
    expect(output).not.toContain("Unexpected argument");
  });

  test("snippets list is recognized (plural)", async () => {
    const proc = Bun.spawn(
      [process.execPath, "run", "src/cli.ts", "snippets", "list", "--account=test@example.com"],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const output = stdout + stderr;

    // Should NOT fail with "Unexpected argument: list"
    expect(output).not.toContain("Unexpected argument");
  });

  test("snippet command appears in help", async () => {
    const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "--help"], {
      cwd: import.meta.dir + "/../..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("snippet");
  });

  test("snippets with unknown subcommand shows error", async () => {
    const proc = Bun.spawn(
      [process.execPath, "run", "src/cli.ts", "snippets", "invalid", "--account=test@example.com"],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const output = stdout + stderr;

    expect(output).toContain("Unknown subcommand");
  });
});
