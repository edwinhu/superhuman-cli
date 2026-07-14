/**
 * Tests for listLabels() and listStarred() in labels.ts
 */

import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { SuperhumanProvider } from "../superhuman-provider";
import type { SuperhumanTokenInfo } from "../superhuman-provider";
import type { SuperhumanConnection } from "../superhuman-api";
import { listLabels, listStarred } from "../labels";
import * as sqliteSearch from "../sqlite-search";

const sampleToken: SuperhumanTokenInfo = {
  token: "test-jwt-token",
  email: "user@example.com",
  accountId: "acct_123",
  expires: Date.now() + 3600_000,
};

/**
 * Create a SuperhumanProvider with mocked portalInvoke and runtimeEvaluate.
 */
function createMockPortalProvider() {
  const mockConn = {
    client: {},
    Runtime: {},
    Input: {},
    Network: {},
    Page: {},
  } as unknown as SuperhumanConnection;

  const provider = new SuperhumanProvider(sampleToken, mockConn);

  const portalMock = mock((): Promise<any> => Promise.resolve(undefined));
  provider.portalInvoke = portalMock;

  const runtimeMock = mock((): Promise<any> => Promise.resolve(undefined));
  provider.runtimeEvaluate = runtimeMock;

  return { provider, portalMock, runtimeMock };
}

function createNoPortalProvider() {
  return new SuperhumanProvider(sampleToken);
}

// -------------------------------------------------------------------------
// listLabels
// -------------------------------------------------------------------------
describe("listLabels", () => {
  test("returns labels from runtimeEvaluate when portal is available", async () => {
    const { provider, runtimeMock } = createMockPortalProvider();

    runtimeMock.mockResolvedValue([
      { id: "INBOX", name: "Inbox", type: "system" },
      { id: "STARRED", name: "Starred", type: "system" },
      { id: "Label_42", name: "Projects", type: "user" },
    ]);

    const labels = await listLabels(provider);

    expect(runtimeMock).toHaveBeenCalledTimes(1);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toEqual({ id: "INBOX", name: "Inbox", type: "system" });
    expect(labels[2]).toEqual({ id: "Label_42", name: "Projects", type: "user" });
  });

  test("returns empty array when runtimeEvaluate returns null", async () => {
    const { provider, runtimeMock } = createMockPortalProvider();
    runtimeMock.mockResolvedValue(null);

    const labels = await listLabels(provider);
    expect(labels).toEqual([]);
  });

  test("throws when no portal is available", async () => {
    const provider = createNoPortalProvider();

    await expect(listLabels(provider)).rejects.toThrow(
      /portal|CDP|Superhuman app/i
    );
  });

  test("throws for non-SuperhumanProvider", async () => {
    const fakeProvider = {} as any;
    await expect(listLabels(fakeProvider)).rejects.toThrow(
      /SuperhumanProvider required/
    );
  });
});

// -------------------------------------------------------------------------
// listStarred
// -------------------------------------------------------------------------
describe("listStarred", () => {
  // listStarred now reads SQLite first; force the SQLite path to return null
  // so the test exercises the portal RPC fallback. Other test files in the
  // suite may mock `../sqlite-search` and leave residual state, so we set the
  // override explicitly before each test here.
  beforeEach(() => {
    mock.module("../sqlite-search", () => ({
      ...sqliteSearch,
      listInboxFromDB: () => null,
    }));
  });
  afterAll(() => {
    mock.module("../sqlite-search", () => sqliteSearch);
  });

  test("calls portalInvoke with STARRED listId", async () => {
    const { provider, portalMock } = createMockPortalProvider();

    portalMock.mockResolvedValue([
      { id: "thread_1", subject: "Important", from: "alice@example.com", date: "2026-03-30" },
      { id: "thread_2", subject: "Follow up", from: "bob@example.com", date: "2026-03-29" },
    ]);

    const starred = await listStarred(provider, 10);

    expect(portalMock).toHaveBeenCalledTimes(1);
    expect(portalMock).toHaveBeenCalledWith(
      "threadInternal",
      "listAsync",
      ["STARRED", { limit: 10, query: "" }]
    );
    expect(starred).toHaveLength(2);
    expect(starred[0]!.id).toBe("thread_1");
    expect(starred[1]!.id).toBe("thread_2");
  });

  test("uses default limit of 50", async () => {
    const { provider, portalMock } = createMockPortalProvider();
    portalMock.mockResolvedValue([]);

    await listStarred(provider);

    expect(portalMock).toHaveBeenCalledWith(
      "threadInternal",
      "listAsync",
      ["STARRED", { limit: 50, query: "" }]
    );
  });

  test("returns empty array when portal returns empty", async () => {
    const { provider, portalMock } = createMockPortalProvider();
    portalMock.mockResolvedValue([]);

    const starred = await listStarred(provider);
    expect(starred).toEqual([]);
  });

  test("throws when no portal is available", async () => {
    const provider = createNoPortalProvider();

    await expect(listStarred(provider)).rejects.toThrow(
      /portal|CDP|Superhuman app/i
    );
  });

  test("throws for non-SuperhumanProvider", async () => {
    const fakeProvider = {} as any;
    await expect(listStarred(fakeProvider)).rejects.toThrow(
      /SuperhumanProvider required/
    );
  });
});
