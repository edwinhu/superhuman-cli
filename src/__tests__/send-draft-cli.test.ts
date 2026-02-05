// src/__tests__/send-draft-cli.test.ts
// Tests for the draft send CLI command (formerly send-draft)
import { test, expect, describe, mock, afterEach, beforeEach } from "bun:test";
import { $ } from "bun";

describe("draft send CLI command", () => {
  describe("command registration", () => {
    test("draft send command appears in help", async () => {
      // Run the CLI with --help and check that draft group (which includes send) is listed
      const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "--help"], {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(stdout).toContain("draft");
    });

    test("draft send command requires draft-id argument", async () => {
      // Run draft send without a draft-id - should show usage error
      const proc = Bun.spawn(
        [process.execPath, "run", "src/cli.ts", "draft", "send", "--account=test@example.com", "--to=recipient@example.com", "--subject=Test", "--body=Test body"],
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

      // Should error because no draft-id provided
      expect(output).toMatch(/draft.*id|required/i);
    });

    test("draft send validates draft-id format", async () => {
      // Run draft send with an invalid draft ID
      const proc = Bun.spawn(
        [process.execPath, "run", "src/cli.ts", "draft", "send", "invalid-id", "--account=test@example.com", "--to=recipient@example.com", "--subject=Test", "--body=Test body"],
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

      // Should error about invalid draft ID format
      expect(output).toMatch(/invalid.*draft.*id|must.*start.*draft00/i);
      expect(exitCode).not.toBe(0);
    });

    test("draft send requires --account flag", async () => {
      // Run draft send without --account flag
      const proc = Bun.spawn(
        [process.execPath, "run", "src/cli.ts", "draft", "send", "draft00abcdef123456", "--to=recipient@example.com", "--subject=Test", "--body=Test body"],
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

      // Should error about missing --account flag
      expect(output).toMatch(/--account.*required|account.*required/i);
      expect(exitCode).not.toBe(0);
    });

    test("draft send requires --to flag", async () => {
      // Run draft send without --to flag
      const proc = Bun.spawn(
        [process.execPath, "run", "src/cli.ts", "draft", "send", "draft00abcdef123456", "--account=test@example.com", "--subject=Test", "--body=Test body"],
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

      // Should error about missing --to flag
      expect(output).toMatch(/--to.*required|recipient.*required/i);
      expect(exitCode).not.toBe(0);
    });

    test("draft send requires --subject flag", async () => {
      // Run draft send without --subject flag
      const proc = Bun.spawn(
        [process.execPath, "run", "src/cli.ts", "draft", "send", "draft00abcdef123456", "--account=test@example.com", "--to=recipient@example.com", "--body=Test body"],
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

      // Should error about missing --subject flag
      expect(output).toMatch(/--subject.*required|subject.*required/i);
      expect(exitCode).not.toBe(0);
    });

    test("draft send requires --body flag", async () => {
      // Run draft send without --body flag
      const proc = Bun.spawn(
        [process.execPath, "run", "src/cli.ts", "draft", "send", "draft00abcdef123456", "--account=test@example.com", "--to=recipient@example.com", "--subject=Test"],
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

      // Should error about missing --body flag
      expect(output).toMatch(/--body.*required|body.*required/i);
      expect(exitCode).not.toBe(0);
    });

    test("draft send shows --thread option in help examples", async () => {
      // Run the CLI with --help and check that --thread is documented
      const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "--help"], {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      // Check that --thread option is documented in draft send examples
      expect(stdout).toMatch(/--thread/);
    });
  });
});
