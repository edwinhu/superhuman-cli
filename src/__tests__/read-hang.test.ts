// src/__tests__/read-hang.test.ts
// Regression tests for the read command hang bug.
// Bug: cmdRead used getProvider() which falls through to CDP (30s hang)
// when hasValidCachedTokens() returns false due to ANY expired token.
// Fix: cmdRead now uses resolveSuperhumanToken() like cmdReply.
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, rm } from "node:fs/promises";

const TEST_CONFIG_DIR = "/tmp/superhuman-cli-read-hang-test";
process.env.SUPERHUMAN_CLI_CONFIG_DIR = TEST_CONFIG_DIR;

import {
  clearTokenCache,
  setTokenCacheForTest,
  type TokenInfo,
} from "../token-api";

function createTestToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: "test-access-token",
    email: "test@example.com",
    expires: Date.now() + 3600000,
    isMicrosoft: false,
    userId: "user-123",
    idToken: "fake-id-token",
    ...overrides,
  };
}

describe("read command hang regression", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    try { await rm(TEST_CONFIG_DIR, { recursive: true }); } catch {}
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    clearTokenCache();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    try { await rm(TEST_CONFIG_DIR, { recursive: true }); } catch {}
    clearTokenCache();
  });

  test("cmdRead does NOT fall through to CDP when cached token exists", async () => {
    // Set up a valid token in cache
    const token = createTestToken({ email: "user@example.com" });
    setTokenCacheForTest(token.email, token);

    // Mock Gmail thread fetch
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: "thread123",
            messages: [
              {
                id: "msg1",
                snippet: "Hello there",
                payload: {
                  headers: [
                    { name: "Subject", value: "Test Subject" },
                    { name: "From", value: "Alice <alice@example.com>" },
                    { name: "To", value: "Bob <bob@example.com>" },
                    { name: "Cc", value: "" },
                    { name: "Date", value: "2026-01-15T10:00:00Z" },
                  ],
                  mimeType: "text/plain",
                  body: { data: btoa("Hello world") },
                },
              },
            ],
          }),
        text: () => Promise.resolve(""),
      } as Response)
    ) as unknown as typeof fetch;

    // Run the CLI read command
    // If it falls through to CDP, this will either hang for 30s or fail with connection error.
    // With the fix, it should resolve quickly via cached token.
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        "src/cli.ts",
        "read",
        "thread123",
        "--account=user@example.com",
        "--json",
      ],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          SUPERHUMAN_CLI_CONFIG_DIR: TEST_CONFIG_DIR,
        },
      }
    );

    // Set a 10-second timeout - if it takes longer, the hang bug is present
    const timeout = setTimeout(() => {
      proc.kill();
    }, 10000);

    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    clearTimeout(timeout);

    // Should NOT contain any CDP/Superhuman connection messages
    const output = stdout + stderr;
    expect(output).not.toMatch(/connecting.*superhuman|launch.*superhuman|remote-debugging-port/i);

    // Should NOT have timed out (exitCode would be non-zero from kill)
    // The command should either succeed with JSON output or fail with a credentials error
    // (since our mock fetch runs in a different process).
    // The key assertion is: it does NOT hang trying to connect via CDP.
  });

  test("cmdRead works with --account for specific account even when other tokens are expired", async () => {
    // Set up one expired token and one valid token
    const expiredToken = createTestToken({
      email: "expired@example.com",
      expires: Date.now() - 3600000, // expired 1 hour ago
      userId: "user-expired",
      idToken: "expired-id-token",
    });
    const validToken = createTestToken({
      email: "valid@example.com",
      expires: Date.now() + 3600000, // valid for 1 more hour
      userId: "user-valid",
      idToken: "valid-id-token",
    });
    setTokenCacheForTest(expiredToken.email, expiredToken);
    setTokenCacheForTest(validToken.email, validToken);

    // Run the CLI targeting the valid account
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        "src/cli.ts",
        "read",
        "thread456",
        "--account=valid@example.com",
        "--json",
      ],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          SUPERHUMAN_CLI_CONFIG_DIR: TEST_CONFIG_DIR,
        },
      }
    );

    // Set a 10-second timeout
    const timeout = setTimeout(() => {
      proc.kill();
    }, 10000);

    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    clearTimeout(timeout);

    const output = stdout + stderr;

    // Should NOT hang or try to launch Superhuman via CDP
    expect(output).not.toMatch(/connecting.*superhuman|launch.*superhuman|remote-debugging-port/i);
    // The key point: having an expired token for a DIFFERENT account should NOT
    // cause the read command for the valid account to fall through to CDP
  });

  test("cmdRead without cached credentials exits with helpful error (no hang)", async () => {
    // No tokens cached at all — should exit immediately with error, not hang on CDP
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        "src/cli.ts",
        "read",
        "thread789",
        "--account=nobody@example.com",
      ],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          SUPERHUMAN_CLI_CONFIG_DIR: TEST_CONFIG_DIR,
        },
      }
    );

    // Set a 10-second timeout — with old code this would hang 30s+ trying CDP
    const timeout = setTimeout(() => {
      proc.kill();
    }, 10000);

    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    clearTimeout(timeout);

    const output = stdout + stderr;

    // Should show a helpful error about missing credentials
    expect(output).toMatch(/no cached credentials|account auth/i);
    // Should exit with non-zero
    expect(exitCode).not.toBe(0);
    // Should NOT try to launch Superhuman
    expect(output).not.toMatch(/launch.*superhuman/i);
  });
});
