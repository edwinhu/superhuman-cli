import { test, expect, describe, mock } from "bun:test";

describe("portalInvoke", () => {
  test("calls Runtime.evaluate with correct expression", async () => {
    const mockEvaluate = mock(() =>
      Promise.resolve({
        result: { type: "object", value: { threads: [] } },
      })
    );
    const conn = { Runtime: { evaluate: mockEvaluate } } as any;

    const { portalInvoke } = await import("../portal-rpc");
    await portalInvoke(conn, "threadInternal", "listAsync", [
      "INBOX",
      { limit: 10 },
    ]);

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    const call = (mockEvaluate.mock.calls[0] as any[])[0];
    expect(call.expression).toContain(
      'window.GoogleAccount.portal.invoke("threadInternal", "listAsync",'
    );
    expect(call.expression).toContain(JSON.stringify(["INBOX", { limit: 10 }]));
    expect(call.awaitPromise).toBe(true);
    expect(call.returnByValue).toBe(true);
  });

  test("returns parsed result value", async () => {
    const mockEvaluate = mock(() =>
      Promise.resolve({
        result: { type: "object", value: { threads: [{ id: "t1" }] } },
      })
    );
    const conn = { Runtime: { evaluate: mockEvaluate } } as any;

    const { portalInvoke } = await import("../portal-rpc");
    const result = await portalInvoke(conn, "threadInternal", "listAsync", [
      "INBOX",
      { limit: 10 },
    ]);

    expect(result).toEqual({ threads: [{ id: "t1" }] });
  });

  test("throws on exception details from Runtime.evaluate", async () => {
    const mockEvaluate = mock(() =>
      Promise.resolve({
        exceptionDetails: {
          exception: { description: "TypeError: portal is null" },
        },
      })
    );
    const conn = { Runtime: { evaluate: mockEvaluate } } as any;

    const { portalInvoke } = await import("../portal-rpc");
    expect(
      portalInvoke(conn, "threadInternal", "listAsync", [])
    ).rejects.toThrow("portal");
  });

  test("throws on undefined result (portal not available)", async () => {
    const mockEvaluate = mock(() =>
      Promise.resolve({
        result: { type: "undefined" },
      })
    );
    const conn = { Runtime: { evaluate: mockEvaluate } } as any;

    const { portalInvoke } = await import("../portal-rpc");
    expect(
      portalInvoke(conn, "threadInternal", "listAsync", [])
    ).rejects.toThrow();
  });

  test("rejects invalid service names (injection prevention)", async () => {
    const mockEvaluate = mock(() => Promise.resolve({ result: { type: "object", value: {} } }));
    const conn = { Runtime: { evaluate: mockEvaluate } } as any;

    const { portalInvoke } = await import("../portal-rpc");
    expect(
      portalInvoke(conn, 'foo"; alert("xss")', "method", [])
    ).rejects.toThrow("Invalid service name");
  });

  test("rejects invalid method names (injection prevention)", async () => {
    const mockEvaluate = mock(() => Promise.resolve({ result: { type: "object", value: {} } }));
    const conn = { Runtime: { evaluate: mockEvaluate } } as any;

    const { portalInvoke } = await import("../portal-rpc");
    expect(
      portalInvoke(conn, "threadInternal", 'list"); drop()', [])
    ).rejects.toThrow("Invalid method name");
  });
});

describe("hasPortalAccess", () => {
  test("returns true when portal.invoke is a function", async () => {
    const mockEvaluate = mock(() =>
      Promise.resolve({
        result: { type: "boolean", value: true },
      })
    );
    const conn = { Runtime: { evaluate: mockEvaluate } } as any;

    const { hasPortalAccess } = await import("../portal-rpc");
    const result = await hasPortalAccess(conn);
    expect(result).toBe(true);
  });

  test("returns false when portal is not available", async () => {
    const mockEvaluate = mock(() =>
      Promise.resolve({
        result: { type: "boolean", value: false },
      })
    );
    const conn = { Runtime: { evaluate: mockEvaluate } } as any;

    const { hasPortalAccess } = await import("../portal-rpc");
    const result = await hasPortalAccess(conn);
    expect(result).toBe(false);
  });

  test("returns false on evaluate exception", async () => {
    const mockEvaluate = mock(() =>
      Promise.resolve({
        exceptionDetails: {
          exception: { description: "ReferenceError: window is not defined" },
        },
      })
    );
    const conn = { Runtime: { evaluate: mockEvaluate } } as any;

    const { hasPortalAccess } = await import("../portal-rpc");
    const result = await hasPortalAccess(conn);
    expect(result).toBe(false);
  });
});
