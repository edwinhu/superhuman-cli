/**
 * Tests for attachment support in MCP reply/reply_all/forward schemas and handlers.
 */
import { test, expect, describe } from "bun:test";
import { ReplySchema, ReplyAllSchema, ForwardSchema } from "../mcp/tools";

describe("MCP schemas accept attachments", () => {
  test("ReplySchema accepts optional attachments array", () => {
    const result = ReplySchema.safeParse({
      threadId: "t1",
      body: "hello",
      attachments: ["/tmp/file.pdf", "/tmp/file2.txt"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments).toEqual(["/tmp/file.pdf", "/tmp/file2.txt"]);
    }
  });

  test("ReplySchema works without attachments", () => {
    const result = ReplySchema.safeParse({
      threadId: "t1",
      body: "hello",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments).toBeUndefined();
    }
  });

  test("ReplyAllSchema accepts optional attachments array", () => {
    const result = ReplyAllSchema.safeParse({
      threadId: "t1",
      body: "hello",
      attachments: ["/tmp/file.pdf"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments).toEqual(["/tmp/file.pdf"]);
    }
  });

  test("ReplyAllSchema works without attachments", () => {
    const result = ReplyAllSchema.safeParse({
      threadId: "t1",
      body: "hello",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments).toBeUndefined();
    }
  });

  test("ForwardSchema accepts optional attachments array", () => {
    const result = ForwardSchema.safeParse({
      threadId: "t1",
      toEmail: "user@example.com",
      body: "hello",
      attachments: ["/tmp/file.pdf"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments).toEqual(["/tmp/file.pdf"]);
    }
  });

  test("ForwardSchema works without attachments", () => {
    const result = ForwardSchema.safeParse({
      threadId: "t1",
      toEmail: "user@example.com",
      body: "hello",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments).toBeUndefined();
    }
  });
});
