import { test, expect, describe } from "bun:test";
import { readFileAsBase64 } from "../attachments";
import { tmpdir } from "os";
import { join } from "path";

const CLI = "src/cli.ts";
const CWD = import.meta.dir + "/../..";

function spawnCli(...args: string[]) {
  return Bun.spawn([process.execPath, "run", CLI, ...args], {
    cwd: CWD,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function getOutput(proc: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, stderr, output: stdout + stderr, exitCode };
}

describe("--attach flag parsing", () => {
  test("--attach appears in help text", async () => {
    const { stdout, exitCode } = await getOutput(spawnCli("--help"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--attach <path>");
  });

  test("parseArgs handles single --attach flag", async () => {
    // reply with --attach should not error on the flag itself
    // It will fail because no credentials, but the flag should be parsed (no "unknown" error)
    const { output } = await getOutput(
      spawnCli("reply", "thread123", "--body=Test", "--attach=/tmp/file.csv", "--account=test@example.com")
    );
    // Should NOT say "unknown option" or similar parse error for --attach
    expect(output).not.toContain("unknown");
    expect(output).not.toContain("Unknown option");
  });

  test("parseArgs handles multiple --attach flags", async () => {
    const { output } = await getOutput(
      spawnCli(
        "reply",
        "thread123",
        "--body=Test",
        "--attach=/tmp/file1.csv",
        "--attach=/tmp/file2.pdf",
        "--account=test@example.com"
      )
    );
    expect(output).not.toContain("unknown");
    expect(output).not.toContain("Unknown option");
  });

  test("--attach works with forward command", async () => {
    const { output } = await getOutput(
      spawnCli(
        "forward",
        "thread123",
        "--to=r@example.com",
        "--body=FYI",
        "--attach=/tmp/doc.pdf",
        "--account=test@example.com"
      )
    );
    expect(output).not.toContain("unknown");
    expect(output).not.toContain("Unknown option");
  });

  test("--attach works with reply-all command", async () => {
    const { output } = await getOutput(
      spawnCli(
        "reply-all",
        "thread123",
        "--body=Test",
        "--attach=/tmp/spreadsheet.xlsx",
        "--account=test@example.com"
      )
    );
    expect(output).not.toContain("unknown");
    expect(output).not.toContain("Unknown option");
  });
});

describe("readFileAsBase64", () => {
  test("reads a file and returns base64 data with filename and mimeType", async () => {
    const tmpFile = join(tmpdir(), "test-attach.csv");
    await Bun.write(tmpFile, "col1,col2\nval1,val2");

    const result = await readFileAsBase64(tmpFile);
    expect(result.filename).toBe("test-attach.csv");
    expect(result.mimeType).toBe("text/csv");
    expect(result.base64Data).toBeTruthy();

    const decoded = Buffer.from(result.base64Data, "base64").toString("utf-8");
    expect(decoded).toBe("col1,col2\nval1,val2");

    await Bun.file(tmpFile).delete();
  });

  test("resolves ~ to home directory", async () => {
    const home = process.env.HOME!;
    const tmpFile = join(home, ".superhuman-test-attach.txt");
    await Bun.write(tmpFile, "test content");

    const result = await readFileAsBase64("~/.superhuman-test-attach.txt");
    expect(result.filename).toBe(".superhuman-test-attach.txt");
    expect(result.base64Data).toBeTruthy();

    await Bun.file(tmpFile).delete();
  });

  test("throws error for non-existent file", async () => {
    await expect(readFileAsBase64("/tmp/nonexistent-file-12345.txt")).rejects.toThrow();
  });

  test("detects common MIME types", async () => {
    const tmpPdf = join(tmpdir(), "test.pdf");
    await Bun.write(tmpPdf, "fake pdf");
    const result = await readFileAsBase64(tmpPdf);
    expect(result.mimeType).toBe("application/pdf");
    await Bun.file(tmpPdf).delete();

    const tmpDocx = join(tmpdir(), "test.docx");
    await Bun.write(tmpDocx, "fake docx");
    const result2 = await readFileAsBase64(tmpDocx);
    expect(result2.mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await Bun.file(tmpDocx).delete();
  });
});

// Note: "forward with --attach integration" and "reply with --attach integration"
// test suites were removed because they tested direct provider API functions
// (createDraftDirect, createReplyDraftDirect, addAttachmentToDraft, sendDraftDirect)
// that have been removed. Attachments now go through the Superhuman native API path
// via MCP or draft-api.ts.
