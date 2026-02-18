/**
 * DraftService Tests
 *
 * Tests the unified draft service that aggregates drafts from multiple providers.
 */

import { describe, it, expect } from "bun:test";
import { DraftService, type IDraftProvider, type Draft } from "../services/draft-service";

// Mock provider for testing
class MockProvider implements IDraftProvider {
  readonly source: Draft["source"];
  private drafts: Draft[];

  constructor(source: Draft["source"], drafts: Draft[]) {
    this.source = source;
    this.drafts = drafts;
  }

  async listDrafts(): Promise<Draft[]> {
    return this.drafts;
  }
}

describe("DraftService", () => {
  it("should initialize with empty providers", () => {
    const service = new DraftService([]);
    expect(service).toBeDefined();
  });

  describe("listDrafts", () => {
    it("should merge drafts from multiple providers", async () => {
      const gmailDrafts: Draft[] = [
        {
          id: "gmail-1",
          subject: "Gmail Draft 1",
          from: "test@gmail.com",
          to: ["recipient@example.com"],
          preview: "Gmail preview 1",
          timestamp: "2024-02-08T12:00:00Z",
          source: "gmail",
        },
        {
          id: "gmail-2",
          subject: "Gmail Draft 2",
          from: "test@gmail.com",
          to: ["other@example.com"],
          preview: "Gmail preview 2",
          timestamp: "2024-02-08T12:30:00Z",
          source: "gmail",
        },
      ];

      const outlookDrafts: Draft[] = [
        {
          id: "outlook-1",
          subject: "Outlook Draft 1",
          from: "test@outlook.com",
          to: ["someone@example.com"],
          preview: "Outlook preview 1",
          timestamp: "2024-02-08T13:00:00Z",
          source: "outlook",
        },
      ];

      const gmailProvider = new MockProvider("gmail", gmailDrafts);
      const outlookProvider = new MockProvider("outlook", outlookDrafts);

      const service = new DraftService([gmailProvider, outlookProvider]);
      const drafts = await service.listDrafts();

      expect(drafts).toHaveLength(3);
      expect(drafts.some((d) => d.source === "gmail")).toBe(true);
      expect(drafts.some((d) => d.source === "outlook")).toBe(true);
      expect(drafts.filter((d) => d.source === "gmail")).toHaveLength(2);
      expect(drafts.filter((d) => d.source === "outlook")).toHaveLength(1);
    });

    it("should return empty array when no providers", async () => {
      const service = new DraftService([]);
      const drafts = await service.listDrafts();
      expect(drafts).toHaveLength(0);
    });

    it("should handle provider errors gracefully", async () => {
      const errorProvider: IDraftProvider = {
        source: "gmail",
        async listDrafts() {
          throw new Error("Provider failed");
        },
      };

      const successDrafts: Draft[] = [
        {
          id: "outlook-1",
          subject: "Outlook Draft",
          from: "test@outlook.com",
          to: ["recipient@example.com"],
          preview: "Works!",
          timestamp: "2024-02-08T12:00:00Z",
          source: "outlook",
        },
      ];
      const successProvider = new MockProvider("outlook", successDrafts);

      const service = new DraftService([errorProvider, successProvider]);
      const drafts = await service.listDrafts();

      // Should still return drafts from the working provider
      expect(drafts).toHaveLength(1);
      expect(drafts[0].source).toBe("outlook");
    });
  });

  it("should throw a clear error when constructed with non-array argument", () => {
    // Regression test: draft delete/update previously passed UserInfo instead of IDraftProvider[]
    const notAnArray = { userId: "123", email: "test@example.com" } as any;
    expect(() => new DraftService(notAnArray)).toThrow(TypeError);
  });
});
