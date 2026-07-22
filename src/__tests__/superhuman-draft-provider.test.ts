/**
 * SuperhumanDraftProvider Tests
 *
 * Tests the Superhuman native draft provider that fetches drafts from userdata.getThreads API.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { SuperhumanDraftProvider } from "../providers/superhuman-draft-provider";
import type { TokenInfo } from "../token-api";

// Store original fetch
const originalFetch = globalThis.fetch;

describe("SuperhumanDraftProvider", () => {
  let mockToken: TokenInfo;

  beforeEach(() => {
    mockToken = {
      accessToken: "mock-access-token",
      idToken: "mock-id-token",
      refreshToken: "mock-refresh-token",
      expires: Date.now() + 3600000,
      email: "test@example.com",
      userId: "user123",
      isMicrosoft: false,
      superhumanToken: {
        token: "mock-superhuman-token",
        expires: Date.now() + 3600000,
      },
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should initialize with token", () => {
    const provider = new SuperhumanDraftProvider(mockToken);
    expect(provider.source).toBe("native");
  });

  describe("listDrafts", () => {
    it("should call userdata.getThreads with correct payload", async () => {
      const mockFetch = mock(async () => {
        return new Response(JSON.stringify({ threadList: [] }));
      });
      globalThis.fetch = mockFetch as any;

      const provider = new SuperhumanDraftProvider(mockToken);
      await provider.listDrafts();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];

      expect(url).toBe("https://mail.superhuman.com/~backend/v3/userdata.getThreads");
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer mock-superhuman-token",
          "Content-Type": "application/json",
        })
      );

      const body = JSON.parse(options.body as string);
      expect(body).toEqual({
        filter: { type: "draft" },
        offset: 0,
        limit: 50,
      });
    });

    it("should parse threadList into Draft[] format", async () => {
      const mockResponse = {
        threadList: [
          {
            thread: {
              messages: {
                draft00abc123: {
                  draft: {
                    id: "draft00abc123",
                    subject: "Test Subject",
                    to: ["test@example.com"],
                    from: "user@example.com",
                    snippet: "Preview text",
                    date: "2026-02-08T23:53:51.053Z",
                  },
                },
              },
            },
          },
        ],
      };

      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify(mockResponse));
      }) as any;

      const provider = new SuperhumanDraftProvider(mockToken);
      const drafts = await provider.listDrafts();

      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        id: "draft00abc123",
        subject: "Test Subject",
        to: ["test@example.com"],
        from: "user@example.com",
        preview: "Preview text",
        timestamp: "2026-02-08T23:53:51.053Z",
        source: "native",
      });
    });

    it("should expose cc and bcc in parsed Draft[]", async () => {
      // Regression: `draft list --json` previously dropped bcc entirely, so a
      // bcc set on a draft was unverifiable. The provider must surface both
      // cc and bcc (defaulting to []) from the userdata.getThreads payload.
      const mockResponse = {
        threadList: [
          {
            id: "draft00thread",
            thread: {
              messages: {
                draft00abc123: {
                  draft: {
                    id: "draft00abc123",
                    subject: "Test Subject",
                    to: ["to@example.com"],
                    cc: ["cc@example.com"],
                    bcc: ["bcc@example.com"],
                    from: "user@example.com",
                    snippet: "Preview text",
                    date: "2026-02-08T23:53:51.053Z",
                  },
                },
              },
            },
          },
        ],
      };

      globalThis.fetch = mock(async () => new Response(JSON.stringify(mockResponse))) as any;

      const provider = new SuperhumanDraftProvider(mockToken);
      const drafts = await provider.listDrafts();

      expect(drafts[0]!.cc).toEqual(["cc@example.com"]);
      expect(drafts[0]!.bcc).toEqual(["bcc@example.com"]);
    });

    it("should default cc and bcc to [] when absent", async () => {
      const mockResponse = {
        threadList: [
          {
            id: "draft00thread",
            thread: {
              messages: {
                draft00abc123: {
                  draft: {
                    id: "draft00abc123",
                    subject: "No recipients beyond to",
                    to: ["to@example.com"],
                    from: "user@example.com",
                    snippet: "x",
                    date: "2026-02-08T23:53:51.053Z",
                  },
                },
              },
            },
          },
        ],
      };

      globalThis.fetch = mock(async () => new Response(JSON.stringify(mockResponse))) as any;

      const provider = new SuperhumanDraftProvider(mockToken);
      const drafts = await provider.listDrafts();

      expect(drafts[0]!.cc).toEqual([]);
      expect(drafts[0]!.bcc).toEqual([]);
    });

    it("should omit drafts tombstoned with discardedAt (deleted drafts)", async () => {
      // Regression (2026-07-22): `draft delete` soft-deletes by writing
      // `users/{u}/threads/{t}/messages/{id}/discardedAt`. userdata.getThreads
      // keeps returning that message (with the tombstone) for as long as the
      // thread stays in the draft index — indefinitely when a sibling live draft
      // holds the thread there. parseThreadList ignored `discardedAt`, so a
      // deleted draft stayed in `draft list` for 120s+ (observed >13h on a real
      // draft) while the Outlook path reflected the delete in 0.1s.
      // Fixture shape captured live from userdata.getThreads.
      const mockResponse = {
        threadList: [
          {
            id: "19f71415d1ba24e8",
            thread: {
              messages: {
                draft00deleted: {
                  discardedAt: "2026-07-21T01:29:31.171000000Z",
                  draft: {
                    id: "draft00deleted",
                    subject: "Deleted draft",
                    to: ["to@example.com"],
                    from: "user@example.com",
                    snippet: "gone",
                    date: "2026-07-21T01:00:00.000Z",
                  },
                  mentions: {},
                  historyId: 1,
                },
                draft00live: {
                  draft: {
                    id: "draft00live",
                    subject: "Live draft",
                    to: ["to@example.com"],
                    from: "user@example.com",
                    snippet: "still here",
                    date: "2026-07-21T02:00:00.000Z",
                  },
                  mentions: {},
                  historyId: 2,
                },
              },
            },
          },
        ],
      };

      globalThis.fetch = mock(async () => new Response(JSON.stringify(mockResponse))) as any;

      const provider = new SuperhumanDraftProvider(mockToken);
      const drafts = await provider.listDrafts();

      expect(drafts.map((d) => d.id)).toEqual(["draft00live"]);
    });

    it("should omit drafts whose discardedAt lives on the draft object", async () => {
      const mockResponse = {
        threadList: [
          {
            id: "draft00thread",
            thread: {
              messages: {
                draft00deleted: {
                  draft: {
                    id: "draft00deleted",
                    subject: "Deleted draft",
                    to: ["to@example.com"],
                    from: "user@example.com",
                    snippet: "gone",
                    date: "2026-07-21T01:00:00.000Z",
                    discardedAt: "2026-07-21T01:29:31.171000000Z",
                  },
                },
              },
            },
          },
        ],
      };

      globalThis.fetch = mock(async () => new Response(JSON.stringify(mockResponse))) as any;

      const provider = new SuperhumanDraftProvider(mockToken);
      const drafts = await provider.listDrafts();

      expect(drafts).toHaveLength(0);
    });

    it("should return empty array when threadList is empty", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify({ threadList: [] }));
      }) as any;

      const provider = new SuperhumanDraftProvider(mockToken);
      const drafts = await provider.listDrafts();

      expect(drafts).toHaveLength(0);
    });

    it("should handle multiple drafts in one message", async () => {
      const mockResponse = {
        threadList: [
          {
            thread: {
              messages: {
                draft00abc123: {
                  draft: {
                    id: "draft00abc123",
                    subject: "Draft 1",
                    to: ["a@example.com"],
                    from: "user@example.com",
                    snippet: "First draft",
                    date: "2026-02-08T12:00:00Z",
                  },
                },
                draft00xyz789: {
                  draft: {
                    id: "draft00xyz789",
                    subject: "Draft 2",
                    to: ["b@example.com"],
                    from: "user@example.com",
                    snippet: "Second draft",
                    date: "2026-02-08T13:00:00Z",
                  },
                },
              },
            },
          },
        ],
      };

      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify(mockResponse));
      }) as any;

      const provider = new SuperhumanDraftProvider(mockToken);
      const drafts = await provider.listDrafts();

      expect(drafts).toHaveLength(2);
      expect(drafts.map((d) => d.id)).toContain("draft00abc123");
      expect(drafts.map((d) => d.id)).toContain("draft00xyz789");
    });

    it("should handle multiple threads with multiple drafts each", async () => {
      const mockResponse = {
        threadList: [
          {
            thread: {
              messages: {
                draft00thread1draft1: {
                  draft: {
                    id: "draft00thread1draft1",
                    subject: "Thread 1 Draft 1",
                    to: [],
                    from: "user@example.com",
                    snippet: "",
                    date: "2026-02-08T12:00:00Z",
                  },
                },
              },
            },
          },
          {
            thread: {
              messages: {
                draft00thread2draft1: {
                  draft: {
                    id: "draft00thread2draft1",
                    subject: "Thread 2 Draft 1",
                    to: [],
                    from: "user@example.com",
                    snippet: "",
                    date: "2026-02-08T13:00:00Z",
                  },
                },
                draft00thread2draft2: {
                  draft: {
                    id: "draft00thread2draft2",
                    subject: "Thread 2 Draft 2",
                    to: [],
                    from: "user@example.com",
                    snippet: "",
                    date: "2026-02-08T14:00:00Z",
                  },
                },
              },
            },
          },
        ],
      };

      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify(mockResponse));
      }) as any;

      const provider = new SuperhumanDraftProvider(mockToken);
      const drafts = await provider.listDrafts();

      expect(drafts).toHaveLength(3);
      expect(drafts.map((d) => d.id)).toContain("draft00thread1draft1");
      expect(drafts.map((d) => d.id)).toContain("draft00thread2draft1");
      expect(drafts.map((d) => d.id)).toContain("draft00thread2draft2");
    });
  });
});
