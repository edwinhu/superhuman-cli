/**
 * Unified Draft Service
 *
 * Aggregates drafts from multiple providers (Gmail, Outlook) with a unified interface.
 */

/**
 * Standard draft object returned by all providers
 */
export interface Draft {
  id: string;
  subject: string;
  from: string;
  to: string[];
  preview: string;
  timestamp: string;
  source: "gmail" | "outlook" | "native";
  threadId?: string; // Optional: used by native Superhuman drafts for update/delete
}

/**
 * Interface that all draft providers must implement
 */
export interface IDraftProvider {
  readonly source: Draft["source"];
  listDrafts(limit?: number, offset?: number): Promise<Draft[]>;
  updateDraft?(draftId: string, updates: Partial<Draft>): Promise<boolean>;
  deleteDraft?(draftId: string): Promise<boolean>;
}

/**
 * Unified service that aggregates drafts from multiple providers
 */
export class DraftService {
  private providers: IDraftProvider[];

  constructor(providers: IDraftProvider[]) {
    this.providers = providers;
  }

  /**
   * Fetch drafts from all registered providers and merge results.
   * Handles provider errors gracefully - failing providers are skipped.
   */
  async listDrafts(limit?: number, offset?: number): Promise<Draft[]> {
    const results = await Promise.allSettled(
      this.providers.map((provider) => provider.listDrafts(limit, offset))
    );

    const drafts: Draft[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        drafts.push(...result.value);
      }
      // Skip failed providers silently
    }

    return drafts;
  }
}
