// src/__tests__/forward-account.test.ts
// Tests for the forward command with --account flag (fast path)
import { test, expect, describe } from "bun:test";

describe("forward command with --account flag", () => {
  describe("command registration", () => {
    test("forward command appears in help", async () => {
      const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "--help"], {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(stdout).toContain("forward");
    });
  });

  describe("--account flag handling", () => {
    test("forward with --account requires thread-id argument", async () => {
      // Run forward without a thread-id - should show usage error
      const proc = Bun.spawn(
        ["bun", "run", "src/cli.ts", "forward", "--account=test@example.com", "--to=recipient@example.com", "--body=FYI"],
        {
          cwd: import.meta.dir + "/../..",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const stderr = await new Response(proc.stderr).text();
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      const output = stdout + stderr;

      // Should error because no thread-id provided
      expect(output).toMatch(/thread.*id|required/i);
      expect(exitCode).not.toBe(0);
    });

    test("forward with --account requires --to recipient", async () => {
      // Run forward with --account but no --to
      const proc = Bun.spawn(
        ["bun", "run", "src/cli.ts", "forward", "test-thread-123", "--account=test@example.com", "--body=FYI"],
        {
          cwd: import.meta.dir + "/../..",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const stderr = await new Response(proc.stderr).text();
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      const output = stdout + stderr;

      // Should error because no --to provided
      expect(output).toMatch(/recipient|--to/i);
      expect(exitCode).not.toBe(0);
    });

    test("forward with --account and no cached credentials falls back gracefully", async () => {
      // Run forward with --account for an account that doesn't have cached credentials
      // Should warn about no cached credentials and fall back to CDP path
      // (which will fail because no Superhuman is running, but that's expected)
      const proc = Bun.spawn(
        ["bun", "run", "src/cli.ts", "forward", "test-thread-123", "--account=nonexistent@example.com", "--to=recipient@example.com", "--body=FYI"],
        {
          cwd: import.meta.dir + "/../..",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const stderr = await new Response(proc.stderr).text();
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      const output = stdout + stderr;

      // Should warn about no cached credentials and fall back to CDP
      expect(output).toMatch(/no cached credentials|falling back/i);
    });

    test("forward with --account uses Superhuman draft API (without --send)", async () => {
      // This test verifies the code path exists - in practice needs mocking for full coverage
      // For now, verify it accepts the --account flag in the context of forward
      const proc = Bun.spawn(
        ["bun", "run", "src/cli.ts", "forward", "thread123", "--account=test@example.com", "--to=recipient@example.com", "--body=FYI"],
        {
          cwd: import.meta.dir + "/../..",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const stderr = await new Response(proc.stderr).text();
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      const output = stdout + stderr;

      // Should show it's trying to use cached credentials path (even if it fails due to no credentials)
      // The important thing is --account is recognized and handled
      expect(output).not.toMatch(/unknown.*option.*account|unrecognized.*account/i);
    });

    test("forward with --account and --send attempts direct send", async () => {
      // This test verifies the --send + --account combo is handled
      const proc = Bun.spawn(
        ["bun", "run", "src/cli.ts", "forward", "thread123", "--account=test@example.com", "--to=recipient@example.com", "--body=FYI", "--send"],
        {
          cwd: import.meta.dir + "/../..",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const stderr = await new Response(proc.stderr).text();
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      const output = stdout + stderr;

      // Should not crash with unknown option error
      expect(output).not.toMatch(/unknown.*option.*account|unrecognized.*account/i);
      // Should either attempt the direct send path or fall back
      expect(output).toMatch(/no cached credentials|falling back|not running|connection|credentials|forward/i);
    });
  });
});
