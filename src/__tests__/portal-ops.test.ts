/**
 * Tests for portal-based write operations:
 * - archive (Task 7)
 * - labels/star (Task 8)
 * - read-status mark read/unread (Task 9)
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import { SuperhumanProvider } from "../superhuman-provider";
import type { SuperhumanTokenInfo } from "../superhuman-provider";
import type { SuperhumanConnection } from "../superhuman-api";
import { archiveThread, deleteThread } from "../archive";
import { addLabel, removeLabel, starThread, unstarThread } from "../labels";
import { markAsRead, markAsUnread } from "../read-status";

const sampleToken: SuperhumanTokenInfo = {
  token: "test-jwt-token",
  email: "user@example.com",
  accountId: "acct_123",
  expires: Date.now() + 3600_000,
};

const THREAD_ID = "thread_abc123";

/**
 * Create a SuperhumanProvider with a mocked portalInvoke.
 * Returns both the provider and the mock function for assertions.
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

  // Replace portalInvoke with a mock
  const portalMock = mock(() => Promise.resolve(undefined));
  provider.portalInvoke = portalMock;

  return { provider, portalMock };
}

/**
 * Create a SuperhumanProvider WITHOUT a CDP connection (no portal).
 */
function createNoPortalProvider() {
  return new SuperhumanProvider(sampleToken);
}

// -------------------------------------------------------------------------
// Task 7: Archive
// -------------------------------------------------------------------------
describe("archiveThread via portal", () => {
  test("calls portalInvoke with modifyLabels to remove INBOX", async () => {
    const { provider, portalMock } = createMockPortalProvider();
    const result = await archiveThread(provider, THREAD_ID);

    expect(result.success).toBe(true);
    expect(portalMock).toHaveBeenCalledTimes(1);
    expect(portalMock).toHaveBeenCalledWith(
      "threadInternal",
      "modifyLabels",
      [THREAD_ID, { addLabelIds: [], removeLabelIds: ["INBOX"] }]
    );
  });

  test("returns error when portalInvoke throws", async () => {
    const { provider, portalMock } = createMockPortalProvider();
    portalMock.mockImplementation(() =>
      Promise.reject(new Error("CDP disconnected"))
    );

    const result = await archiveThread(provider, THREAD_ID);
    expect(result.success).toBe(false);
    expect(result.error).toContain("CDP disconnected");
  });

  test("throws when SuperhumanProvider has no portal", async () => {
    const provider = createNoPortalProvider();
    const result = await archiveThread(provider, THREAD_ID);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Requires running Superhuman app");
  });
});

describe("deleteThread via portal", () => {
  test("calls portalInvoke with modifyLabels to add TRASH", async () => {
    const { provider, portalMock } = createMockPortalProvider();
    const result = await deleteThread(provider, THREAD_ID);

    expect(result.success).toBe(true);
    expect(portalMock).toHaveBeenCalledTimes(1);
    expect(portalMock).toHaveBeenCalledWith(
      "threadInternal",
      "modifyLabels",
      [THREAD_ID, { addLabelIds: ["TRASH"], removeLabelIds: [] }]
    );
  });
});

// -------------------------------------------------------------------------
// Task 8: Labels / Star
// -------------------------------------------------------------------------
describe("addLabel via portal", () => {
  test("calls portalInvoke with modifyLabels to add label", async () => {
    const { provider, portalMock } = createMockPortalProvider();
    const result = await addLabel(provider, THREAD_ID, "Label_42");

    expect(result.success).toBe(true);
    expect(portalMock).toHaveBeenCalledWith(
      "threadInternal",
      "modifyLabels",
      [THREAD_ID, { addLabelIds: ["Label_42"], removeLabelIds: [] }]
    );
  });

  test("returns error when no portal", async () => {
    const provider = createNoPortalProvider();
    const result = await addLabel(provider, THREAD_ID, "Label_42");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Requires running Superhuman app");
  });
});

describe("removeLabel via portal", () => {
  test("calls portalInvoke with modifyLabels to remove label", async () => {
    const { provider, portalMock } = createMockPortalProvider();
    const result = await removeLabel(provider, THREAD_ID, "Label_42");

    expect(result.success).toBe(true);
    expect(portalMock).toHaveBeenCalledWith(
      "threadInternal",
      "modifyLabels",
      [THREAD_ID, { addLabelIds: [], removeLabelIds: ["Label_42"] }]
    );
  });
});

describe("starThread via portal", () => {
  test("calls portalInvoke with modifyLabels to add STARRED", async () => {
    const { provider, portalMock } = createMockPortalProvider();
    const result = await starThread(provider, THREAD_ID);

    expect(result.success).toBe(true);
    expect(portalMock).toHaveBeenCalledWith(
      "threadInternal",
      "modifyLabels",
      [THREAD_ID, { addLabelIds: ["STARRED"], removeLabelIds: [] }]
    );
  });
});

describe("unstarThread via portal", () => {
  test("calls portalInvoke with modifyLabels to remove STARRED", async () => {
    const { provider, portalMock } = createMockPortalProvider();
    const result = await unstarThread(provider, THREAD_ID);

    expect(result.success).toBe(true);
    expect(portalMock).toHaveBeenCalledWith(
      "threadInternal",
      "modifyLabels",
      [THREAD_ID, { addLabelIds: [], removeLabelIds: ["STARRED"] }]
    );
  });
});

// -------------------------------------------------------------------------
// Task 9: Read Status
// -------------------------------------------------------------------------
describe("markAsRead via portal", () => {
  test("calls portalInvoke with modifyLabels to remove UNREAD", async () => {
    const { provider, portalMock } = createMockPortalProvider();
    const result = await markAsRead(provider, THREAD_ID);

    expect(result.success).toBe(true);
    expect(portalMock).toHaveBeenCalledWith(
      "threadInternal",
      "modifyLabels",
      [THREAD_ID, { addLabelIds: [], removeLabelIds: ["UNREAD"] }]
    );
  });

  test("falls back to backend when no portal", async () => {
    const provider = createNoPortalProvider();
    provider.backendFetch = mock(() => Promise.resolve({})) as any;
    const result = await markAsRead(provider, THREAD_ID);
    expect(result.success).toBe(true);
    expect(provider.backendFetch).toHaveBeenCalledTimes(1);
  });
});

describe("markAsUnread via portal", () => {
  test("calls portalInvoke with modifyLabels to add UNREAD", async () => {
    const { provider, portalMock } = createMockPortalProvider();
    const result = await markAsUnread(provider, THREAD_ID);

    expect(result.success).toBe(true);
    expect(portalMock).toHaveBeenCalledWith(
      "threadInternal",
      "modifyLabels",
      [THREAD_ID, { addLabelIds: ["UNREAD"], removeLabelIds: [] }]
    );
  });

  test("falls back to backend when no portal", async () => {
    const provider = createNoPortalProvider();
    provider.backendFetch = mock(() => Promise.resolve({})) as any;
    const result = await markAsUnread(provider, THREAD_ID);
    expect(result.success).toBe(true);
    expect(provider.backendFetch).toHaveBeenCalledTimes(1);
  });
});
