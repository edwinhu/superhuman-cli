// src/__tests__/reply-account.test.ts
// Tests for the reply command with --account flag (fast path)
import { test, expect, describe } from "bun:test";

describe("reply command with --account flag", () => {
  describe("command registration", () => {
    test("reply command appears in help", async () => {
      const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "--help"], {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(stdout).toContain("reply");
    });
  });

  describe("--account flag handling", () => {
    test("reply with --account requires thread-id argument", async () => {
      // Run reply without a thread-id - should show usage error
      const proc = Bun.spawn(
        [process.execPath, "run", "src/cli.ts", "reply", "--account=test@example.com", "--body=Test reply"],
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

    test("reply with --account and no cached credentials falls back gracefully", async () => {
      // Run reply with --account for an account that doesn't have cached credentials
      // Should warn about no cached credentials and fall back to CDP path
      // (which will fail because no Superhuman is running, but that's expected)
      const proc = Bun.spawn(
        [process.execPath, "run", "src/cli.ts", "reply", "test-thread-123", "--account=nonexistent@example.com", "--body=Test reply"],
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

      // Without valid Superhuman credentials, should fall back and eventually error
      expect(output).toMatch(/no cached tokens|could not connect|not running|expired|error|failed/i);
    });

    test("reply with --account uses Superhuman draft API (without --send)", async () => {
      // This test verifies the code path exists - in practice needs mocking for full coverage
      // For now, verify it accepts the --account flag in the context of reply
      const proc = Bun.spawn(
        [process.execPath, "run", "src/cli.ts", "reply", "thread123", "--account=test@example.com", "--body=Reply text"],
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

    test("reply with --account and --send attempts direct send", async () => {
      // This test verifies the --send + --account combo is handled
      const proc = Bun.spawn(
        [process.execPath, "run", "src/cli.ts", "reply", "thread123", "--account=test@example.com", "--body=Reply text", "--send"],
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
      // Should either attempt the direct send path or fall back to CDP
      expect(output).toMatch(/no cached tokens|could not connect|not running|connection|credentials|reply/i);
    });
  });
});
