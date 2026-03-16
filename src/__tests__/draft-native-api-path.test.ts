// src/__tests__/draft-native-api-path.test.ts
// Regression test: when provider is "superhuman", draft create should ALWAYS use
// the native Superhuman API (createDraftWithUserInfo), never createDraftViaProvider
// which dispatches via the provider's native API (MS Graph for Outlook -> Exchange IDs).
import { test, expect, describe, afterEach, mock, beforeEach } from "bun:test";
import { getUserInfoFromCache, createDraftWithUserInfo } from "../draft-api";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("draft create uses native Superhuman API when credentials available", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createMockFetch(response: { ok: boolean; status?: number; data?: unknown; text?: string }) {
    const mockFn = mock(() =>
      Promise.resolve({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: () => Promise.resolve(response.data ?? {}),
        text: () => Promise.resolve(response.text ?? ""),
      } as Response)
    );
    globalThis.fetch = mockFn as unknown as typeof fetch;
    return mockFn;
  }

  test("createDraftWithUserInfo produces draft00 IDs for BCC-only drafts", async () => {
    const mockFetch = createMockFetch({ ok: true, data: {} });

    const userInfo = getUserInfoFromCache(
      "user123",
      "ehu@law.virginia.edu",
      "fake-id-token"
    );

    const result = await createDraftWithUserInfo(userInfo, {
      to: [],
      bcc: ["student@example.com"],
      subject: "BCC Test",
      body: "<p>Hello</p>",
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(result.draftId!.startsWith("draft00")).toBe(true);

    // Verify the native Superhuman API endpoint was called
    const calls = mockFetch.mock.calls;
    expect(calls.length).toBe(1);
    const [url] = calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("userdata.writeMessage");
    expect(url).not.toContain("graph.microsoft.com");
    expect(url).not.toContain("googleapis.com");
  });

  test("createDraftWithUserInfo produces draft00 IDs when to is empty array", async () => {
    const mockFetch = createMockFetch({ ok: true, data: {} });

    const userInfo = getUserInfoFromCache(
      "user123",
      "ehu@law.virginia.edu",
      "fake-id-token"
    );

    const result = await createDraftWithUserInfo(userInfo, {
      to: [],
      cc: ["colleague@example.com"],
      subject: "CC Only Test",
      body: "<p>FYI</p>",
    });

    expect(result.success).toBe(true);
    expect(result.draftId!.startsWith("draft00")).toBe(true);
  });
});

describe("CLI fallback path rejects provider API when provider is superhuman", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "superhuman-cli-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("errors out instead of using provider API when no idToken/userId", async () => {
    // Create a token cache with accessToken but NO superhumanToken/userId
    // This simulates the bug scenario: user has a cached token from the
    // provider but hasn't run account auth to get Superhuman native creds
    const tokensData = {
      version: 1,
      accounts: {
        "testuser@outlook.com": {
          type: "microsoft" as const,
          accessToken: "fake-access-token",
          expires: Date.now() + 3600000,
          // NOTE: no superhumanToken, no userId — this is the bug trigger
        },
      },
      lastUpdated: Date.now(),
    };
    await writeFile(join(tmpDir, "tokens.json"), JSON.stringify(tokensData));

    const proc = Bun.spawn(
      [
        process.execPath, "run", "src/cli.ts",
        "draft", "create",
        "--bcc=student@example.com",
        "--subject=BCC Test",
        "--body=Hello class",
        "--provider=superhuman",
      ],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          SUPERHUMAN_CLI_CONFIG_DIR: tmpDir,
        },
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = stdout + stderr;
    const exitCode = await proc.exited;

    // Should NOT use the CDP/provider fallback (which produces Exchange IDs)
    expect(output).not.toContain("Creating draft via Superhuman API (CDP)");
    // Should NOT call createDraftViaProvider which uses MS Graph
    expect(output).not.toContain("Creating draft via Gmail/MS Graph API");

    // Should error out asking user to authenticate
    expect(output).toContain("account auth");
    expect(exitCode).not.toBe(0);
  });

  test("uses native API when idToken and userId are present", async () => {
    // Create a token cache WITH superhumanToken and userId
    const tokensData = {
      version: 1,
      accounts: {
        "testuser@outlook.com": {
          type: "microsoft" as const,
          accessToken: "fake-access-token",
          expires: Date.now() + 3600000,
          userId: "fake-user-id",
          superhumanToken: {
            token: "fake-id-token",
            expires: Date.now() + 3600000,
          },
        },
      },
      lastUpdated: Date.now(),
    };
    await writeFile(join(tmpDir, "tokens.json"), JSON.stringify(tokensData));

    const proc = Bun.spawn(
      [
        process.execPath, "run", "src/cli.ts",
        "draft", "create",
        "--bcc=student@example.com",
        "--subject=BCC Test",
        "--body=Hello class",
        "--provider=superhuman",
      ],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          SUPERHUMAN_CLI_CONFIG_DIR: tmpDir,
        },
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = stdout + stderr;

    // Should use the native Superhuman API path (fast path)
    expect(output).toContain("Creating draft via Superhuman API...");
    // Should NOT use CDP fallback or provider API
    expect(output).not.toContain("Creating draft via Superhuman API (CDP)");
    expect(output).not.toContain("Creating draft via Gmail/MS Graph API");
  });
});
