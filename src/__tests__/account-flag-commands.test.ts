// Tests that reply, reply-all, and forward all handle --account flag correctly
import { test, expect, describe } from "bun:test";

const CLI = "src/cli.ts";
const CWD = import.meta.dir + "/../..";

function spawnCli(...args: string[]) {
  return Bun.spawn([process.execPath, "run", CLI, ...args], {
    cwd: CWD,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function getOutput(proc: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, output: stdout + stderr, exitCode };
}

const commands = [
  {
    name: "reply",
    baseArgs: ["reply"],
    withThread: ["reply", "thread123", "--body=Test"],
    withThreadAndSend: ["reply", "thread123", "--body=Test", "--send"],
    requiresTo: false,
  },
  {
    name: "reply-all",
    baseArgs: ["reply-all"],
    withThread: ["reply-all", "thread123", "--body=Test"],
    withThreadAndSend: ["reply-all", "thread123", "--body=Test", "--send"],
    requiresTo: false,
  },
  {
    name: "forward",
    baseArgs: ["forward"],
    withThread: ["forward", "thread123", "--to=r@example.com", "--body=FYI"],
    withThreadAndSend: ["forward", "thread123", "--to=r@example.com", "--body=FYI", "--send"],
    requiresTo: true,
  },
];

for (const cmd of commands) {
  describe(`${cmd.name} command with --account flag`, () => {
    test("appears in help", async () => {
      const { stdout, exitCode } = await getOutput(spawnCli("--help"));
      expect(exitCode).toBe(0);
      expect(stdout).toContain(cmd.name);
    });

    test("requires thread-id argument", async () => {
      const { output, exitCode } = await getOutput(
        spawnCli(...cmd.baseArgs, "--account=test@example.com", "--body=Test")
      );
      expect(output).toMatch(/thread.*id|required/i);
      expect(exitCode).not.toBe(0);
    });

    if (cmd.requiresTo) {
      test("requires --to recipient", async () => {
        const { output, exitCode } = await getOutput(
          spawnCli(cmd.name, "thread123", "--account=test@example.com", "--body=FYI")
        );
        expect(output).toMatch(/recipient|--to/i);
        expect(exitCode).not.toBe(0);
      });
    }

    test("falls back gracefully with no cached credentials", async () => {
      const { output } = await getOutput(
        spawnCli(...cmd.withThread, "--account=nonexistent@example.com")
      );
      expect(output).toMatch(/no cached tokens|could not|not running|expired|error|failed/i);
    });

    test("accepts --account flag without unknown option error", async () => {
      const { output } = await getOutput(
        spawnCli(...cmd.withThread, "--account=test@example.com")
      );
      expect(output).not.toMatch(/unknown.*option.*account|unrecognized.*account/i);
    });

    test("accepts --account with --send", async () => {
      const { output } = await getOutput(
        spawnCli(...cmd.withThreadAndSend, "--account=test@example.com")
      );
      expect(output).not.toMatch(/unknown.*option.*account|unrecognized.*account/i);
    });
  });
}
