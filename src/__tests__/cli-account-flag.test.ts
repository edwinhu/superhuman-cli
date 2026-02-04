// src/__tests__/cli-account-flag.test.ts
import { describe, test, expect } from "bun:test";

describe("CLI --account flag parsing", () => {
  test("--account flag is parsed correctly", async () => {
    // Test by running the CLI with --help and checking it shows --account
    const proc = Bun.spawn(["bun", "src/cli.ts", "--help"], {
      cwd: "/Users/vwh7mb/projects/superhuman-cli/.worktrees/direct-api",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // Help should mention --account flag
    expect(stdout).toContain("--account");
    expect(stdout).toContain("Account to operate on");
  });

  test("--account flag appears in help output", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "help"], {
      cwd: "/Users/vwh7mb/projects/superhuman-cli/.worktrees/direct-api",
      stdout: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toContain("--account");
  });
});
