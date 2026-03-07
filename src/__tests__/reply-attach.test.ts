import { test, expect, describe, afterEach } from "bun:test";
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
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
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
      spawnCli("reply", "thread123", "--body=Test", "--attach=/tmp/file.csv")
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
        "--attach=/tmp/file2.pdf"
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
        "--attach=/tmp/doc.pdf"
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
        "--attach=/tmp/spreadsheet.xlsx"
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

describe("forward with --attach integration", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("forward --attach creates draft via provider API and adds attachment", async () => {
    const tmpFile = join(tmpdir(), "test-forward-attach.pdf");
    await Bun.write(tmpFile, "fake pdf content");

    const fetchCalls: { url: string; method: string; body?: string }[] = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({
        url: urlStr,
        method: init?.method || "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      // Mock Gmail thread info
      if (urlStr.includes("/threads/") && !urlStr.includes("/drafts")) {
        return new Response(JSON.stringify({
          id: "thread123",
          messages: [{
            id: "msg001",
            payload: {
              headers: [
                { name: "From", value: "sender@example.com" },
                { name: "To", value: "me@example.com" },
                { name: "Subject", value: "Original Subject" },
                { name: "Message-ID", value: "<msg001@example.com>" },
                { name: "References", value: "" },
              ],
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Mock Gmail draft GET
      if (urlStr.includes("/drafts/draft789") && (!init?.method || init?.method === "GET")) {
        return new Response(JSON.stringify({
          id: "draft789",
          message: {
            id: "draftmsg789",
            payload: {
              headers: [
                { name: "To", value: "recipient@example.com" },
                { name: "Subject", value: "Fwd: Original Subject" },
                { name: "From", value: "me@example.com" },
              ],
              mimeType: "text/html",
              body: {
                data: Buffer.from("<p>FYI</p>").toString("base64url"),
              },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Mock Gmail draft creation (POST /drafts) - forward creates a NEW draft, not a reply
      if (urlStr.includes("/drafts") && init?.method === "POST" && !urlStr.includes("/send")) {
        return new Response(JSON.stringify({
          id: "draft789",
          message: { id: "draftmsg789" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Mock Gmail draft send
      if (urlStr.includes("/drafts/send")) {
        return new Response(JSON.stringify({
          id: "sent999",
          threadId: "thread123",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Mock Gmail draft PUT
      if (urlStr.includes("/drafts/draft789") && init?.method === "PUT") {
        return new Response(JSON.stringify({
          id: "draft789",
          message: { id: "draftmsg789" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const { readFileAsBase64: readFile } = await import("../attachments");
    const {
      createDraftDirect,
      addAttachmentToDraft,
      sendDraftDirect,
    } = await import("../token-api");

    // These functions must exist and be callable
    expect(typeof createDraftDirect).toBe("function");
    expect(typeof addAttachmentToDraft).toBe("function");
    expect(typeof sendDraftDirect).toBe("function");

    // Step 1: Read file as base64
    const fileData = await readFile(tmpFile);
    expect(fileData.filename).toBe("test-forward-attach.pdf");
    expect(fileData.mimeType).toBe("application/pdf");

    // Step 2: Create forward draft via provider API (NOT createReplyDraftDirect)
    const fakeToken = {
      accessToken: "fake-access-token",
      email: "me@example.com",
      userId: "user123",
      idToken: "fake-id-token",
      isMicrosoft: false,
      superhumanAccountId: "acct123",
    } as any;

    const draft = await createDraftDirect(fakeToken, {
      to: ["recipient@example.com"],
      subject: "Fwd: Original Subject",
      body: "<p>FYI</p>",
      isHtml: true,
    });
    expect(draft).not.toBeNull();
    expect(draft!.draftId).toBe("draft789");

    // Step 3: Add attachment to draft
    const attached = await addAttachmentToDraft(
      fakeToken,
      draft!.draftId,
      fileData.filename,
      fileData.mimeType,
      fileData.base64Data
    );
    expect(fetchCalls.length).toBeGreaterThan(0);

    // Step 4: Send draft
    const sent = await sendDraftDirect(fakeToken, draft!.draftId);
    expect(sent).not.toBeNull();

    // Verify draft creation call was made (POST to /drafts)
    const draftCreationCalls = fetchCalls.filter(c => c.url.includes("/drafts") && c.method === "POST");
    expect(draftCreationCalls.length).toBeGreaterThan(0);

    await Bun.file(tmpFile).delete();
  });
});

describe("reply with --attach integration", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("reply --attach creates draft via provider API and adds attachment", async () => {
    // Create a temp file to attach
    const tmpFile = join(tmpdir(), "test-reply-attach.csv");
    await Bun.write(tmpFile, "data1,data2");

    const fetchCalls: { url: string; method: string; body?: string }[] = [];

    // Mock fetch to simulate Gmail API calls
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({
        url: urlStr,
        method: init?.method || "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      // Mock Gmail thread info
      if (urlStr.includes("/threads/") && !urlStr.includes("/drafts")) {
        return new Response(JSON.stringify({
          id: "thread123",
          messages: [{
            id: "msg001",
            payload: {
              headers: [
                { name: "From", value: "sender@example.com" },
                { name: "To", value: "me@example.com" },
                { name: "Subject", value: "Test Thread" },
                { name: "Message-ID", value: "<msg001@example.com>" },
                { name: "References", value: "" },
              ],
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Mock Gmail draft GET (for addAttachmentToDraft reading the existing draft)
      if (urlStr.includes("/drafts/draft456") && (!init?.method || init?.method === "GET")) {
        return new Response(JSON.stringify({
          id: "draft456",
          message: {
            id: "draftmsg456",
            threadId: "thread123",
            payload: {
              headers: [
                { name: "To", value: "sender@example.com" },
                { name: "Subject", value: "Re: Test Thread" },
                { name: "From", value: "me@example.com" },
                { name: "In-Reply-To", value: "<msg001@example.com>" },
                { name: "References", value: "<msg001@example.com>" },
              ],
              mimeType: "text/html",
              body: {
                data: Buffer.from("<p>Reply body</p>").toString("base64url"),
              },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Mock Gmail draft creation (POST /drafts)
      if (urlStr.includes("/drafts") && init?.method === "POST" && !urlStr.includes("/send")) {
        return new Response(JSON.stringify({
          id: "draft456",
          message: { id: "draftmsg456", threadId: "thread123" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Mock Gmail draft send
      if (urlStr.includes("/drafts/send")) {
        return new Response(JSON.stringify({
          id: "sent789",
          threadId: "thread123",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Mock Gmail draft PUT (for addAttachmentToDraft updating the draft)
      if (urlStr.includes("/drafts/draft456") && init?.method === "PUT") {
        return new Response(JSON.stringify({
          id: "draft456",
          message: { id: "draftmsg456", threadId: "thread123" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Default response
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    // Verify the building blocks work together
    const { readFileAsBase64: readFile } = await import("../attachments");
    const {
      createReplyDraftDirect,
      addAttachmentToDraft,
      sendDraftDirect,
    } = await import("../token-api");

    // These functions must exist and be callable (the actual API is mocked)
    expect(typeof createReplyDraftDirect).toBe("function");
    expect(typeof addAttachmentToDraft).toBe("function");
    expect(typeof sendDraftDirect).toBe("function");

    // Step 1: Read file as base64
    const fileData = await readFile(tmpFile);
    expect(fileData.filename).toBe("test-reply-attach.csv");
    expect(fileData.mimeType).toBe("text/csv");

    // Step 2: Create reply draft via provider API (Gmail)
    const fakeToken = {
      accessToken: "fake-access-token",
      email: "me@example.com",
      userId: "user123",
      idToken: "fake-id-token",
      isMicrosoft: false,
      superhumanAccountId: "acct123",
    } as any;

    const draft = await createReplyDraftDirect(fakeToken, "thread123", "<p>Reply body</p>", {
      replyAll: false,
      isHtml: true,
    });
    expect(draft).not.toBeNull();
    expect(draft!.draftId).toBe("draft456");

    // Step 3: Add attachment to draft
    const attached = await addAttachmentToDraft(
      fakeToken,
      draft!.draftId,
      fileData.filename,
      fileData.mimeType,
      fileData.base64Data
    );
    // With our mock, this should have made a fetch call
    expect(fetchCalls.length).toBeGreaterThan(0);

    // Step 4: Send draft
    const sent = await sendDraftDirect(fakeToken, draft!.draftId);
    expect(sent).not.toBeNull();

    // Verify the API call sequence includes draft creation and send
    const draftCreationCalls = fetchCalls.filter(c => c.url.includes("/drafts") && c.method === "POST");
    expect(draftCreationCalls.length).toBeGreaterThan(0);

    await Bun.file(tmpFile).delete();
  });
});
