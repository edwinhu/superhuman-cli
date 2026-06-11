import { test, expect, afterEach } from "bun:test";
import { readFileAsBase64, downloadRawMessage } from "../attachments";
import { tmpdir } from "os";
import { join } from "path";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test(".eml files map to message/rfc822", async () => {
  const path = join(tmpdir(), `export-eml-test-${process.pid}.eml`);
  await Bun.write(path, "From: a@b.c\r\n\r\nhello");
  const data = await readFileAsBase64(path);
  expect(data.mimeType).toBe("message/rfc822");
});

test("downloadRawMessage decodes Gmail base64url raw content", async () => {
  const original = "From: a@b.c\r\nSubject: hi\r\n\r\nbody+/=test";
  const base64url = Buffer.from(original)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  let requestedUrl = "";
  globalThis.fetch = (async (url: any) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ raw: base64url }), { status: 200 });
  }) as any;

  const bytes = await downloadRawMessage("19eb40e582a983ca", {
    accessToken: "tok",
    isMicrosoft: false,
  });
  expect(requestedUrl).toContain("gmail.googleapis.com");
  expect(requestedUrl).toContain("format=raw");
  expect(Buffer.from(bytes).toString("utf8")).toBe(original);
});

test("downloadRawMessage returns MS Graph $value bytes verbatim", async () => {
  const original = "From: a@b.c\r\n\r\nms graph body";
  let requestedUrl = "";
  globalThis.fetch = (async (url: any) => {
    requestedUrl = String(url);
    return new Response(Buffer.from(original), { status: 200 });
  }) as any;

  const bytes = await downloadRawMessage("AAkALgAAA", {
    accessToken: "tok",
    isMicrosoft: true,
  });
  expect(requestedUrl).toContain("graph.microsoft.com");
  expect(requestedUrl).toContain("/$value");
  expect(Buffer.from(bytes).toString("utf8")).toBe(original);
});

test("downloadRawMessage throws on provider error", async () => {
  globalThis.fetch = (async () =>
    new Response("nope", { status: 404 })) as any;
  expect(
    downloadRawMessage("bad-id", { accessToken: "tok", isMicrosoft: false })
  ).rejects.toThrow("Gmail API error 404");
});

test("export eml without a thread id prints usage and exits 1", async () => {
  const proc = Bun.spawn(
    [process.execPath, "src/cli.ts", "export", "eml"],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  const out = (await new Response(proc.stdout).text()) +
    (await new Response(proc.stderr).text());
  expect(exitCode).toBe(1);
  expect(out).toContain("superhuman export eml <thread-id>");
});

test("unknown export subcommand prints usage and exits 1", async () => {
  const proc = Bun.spawn(
    [process.execPath, "src/cli.ts", "export", "bogus"],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  const out = (await new Response(proc.stdout).text()) +
    (await new Response(proc.stderr).text());
  expect(exitCode).toBe(1);
  expect(out).toContain("Unknown subcommand: export bogus");
});
